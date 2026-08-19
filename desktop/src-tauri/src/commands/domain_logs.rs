//! Tauri-команда чтения хвоста лог-файла домена (`domain_read_log_tail`).
//!
//! Голова команды — та же, что у `domain_read_facts`: резолв домена и сервера из
//! локального кэша, расшифровка SSH-блоба, `zeroize` пароля сразу после
//! `connect`, обработка `HOST_KEY_UNKNOWN` внутри
//! `ssh_connect_session_with_timeout`. Дальше начинаются два отличия, и оба
//! принципиальны.
//!
//! **Первое — гейт пути.** Читается не любой файл, а только тот, что стоит в
//! `fp_facts.logs[].path` этого домена, и проверка идёт ДО открытия сессии.
//! Ровно ради неё труба сделана Rust-командой, а не вызовом `ssh_exec` из
//! фронта: там путь пришёл бы из JS как есть, и «покажи мне `/etc/shadow`»
//! отличалось бы от «покажи мне лог» только текстом строки. Плюс пароль не
//! появляется в куче JS, где его нельзя занулить.
//!
//! **Второе — никакого write-back.** Ни `fp_facts`, ни `fp_facts_at`, ни
//! `fp_checked_at`, ни `fp_check_error` — ни на успехе, ни на провале. Хвост и
//! снимок разные измерения: провал чтения лога не есть провал снимка, а сдвиг
//! `fp_checked_at` записал бы попытку снять снимок, которой не было.
//!
//! **И содержимое никуда не уезжает.** В access-логе стоят чужие IP, URL с query
//! string и user-agent; `domains.fp_facts` — открытая JSON-колонка в Postgres.
//! Хвост живёт только в памяти десктопа: ни на сервере, ни в SQLCipher-кэше, ни
//! в аудите его нет. Аудита у команды поэтому тоже нет — она ничего не меняет.

use std::time::Duration;

use tauri::{AppHandle, State};
use zeroize::Zeroize;

use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_i64, json_str};
use crate::commands::ssh::ssh_connect_session_with_timeout;
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::ssh::fastpanel_logs::{read_log_tail, LogTail};
use crate::sync::cache;
use crate::sync::http::ApiClient;

/// Через сколько молчания считаем сессию чтения хвоста оборванной.
///
/// Заведомо больше exec-бюджета единственной команды (`LOG_TAIL_EXEC_TIMEOUT`):
/// inactivity убивает не команду, а всю СЕССИЮ, и закройся канал раньше, чем
/// истечёт exec, наружу поехала бы смерть транспорта вместо честного таймаута
/// чтения. Соотношение закреплено тестом ниже — как у `FACTS_SESSION_TIMEOUT`.
/// Команда ровно одна, поэтому запас скромный: 60 c против 30 c.
const LOG_TAIL_SESSION_TIMEOUT: Duration = Duration::from_secs(60);

/// Прочитать последние строки лог-файла домена. ТОЛЬКО чтение: ни сервер, ни
/// строка домена в БД не меняются.
///
/// `path` обязан стоять в снимке домена (`fp_facts.logs[].path`) — иначе отказ
/// ДО коннекта. Ошибки соединения (в т.ч. `HOST_KEY_UNKNOWN`) проходят наверх
/// как есть, как в `domain_read_facts`, но, в отличие от неё, ничего не
/// фиксируют на сервере.
///
/// `api` нужен здесь ТОЛЬКО ради `blob_plaintext` (достать и расшифровать
/// SSH-пароль сервера). Сказано прямо, потому что у соседней команды тот же
/// параметр служит ещё и write-back'у, — здесь write-back'а нет и быть не должно.
#[tauri::command]
pub async fn domain_read_log_tail(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    path: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<LogTail, CommandError> {
    let mut key = keychain::load_vault_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let cache_file = cache_path(&handle)?;
    let conn = cache::open(&cache_file, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let domain_row = cache::get_row_fields(&conn, "domains", &domain_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("domain not in local cache".into()))?;

    // ГЕЙТ ПУТИ — до блоба, до коннекта, до чего бы то ни было. Читаем ровно те
    // файлы, которые вкладка нарисовала чипами: нет снимка → нет чипов → нечего
    // и читать. Не «упрощать» проверкой префикса каталога и не переносить её
    // внутрь сессии: смысл в том, что на непроверенный путь SSH не открывается
    // вовсе.
    if !path_is_known(domain_row.get("fp_facts"), &path) {
        key.zeroize();
        return Err(CommandError::Api(
            "path is not a log file of this domain".into(),
        ));
    }

    let server_id = json_i64(
        domain_row
            .get("server_id")
            .ok_or_else(|| CommandError::Api("domain has no server_id".into()))?,
    )
    .ok_or_else(|| CommandError::Api("invalid server_id".into()))?
    .to_string();

    let server_row = cache::get_row_fields(&conn, "servers", &server_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("server not in local cache".into()))?;

    let blob_id = server_row
        .get("ssh_password_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server has no ssh_password_blob_id".into()))?;
    let password = blob_plaintext(&api, &key, &blob_id).await;
    // Ключ хранилища дальше не нужен: только SSH. Гасим до разбора результата.
    key.zeroize();
    let mut password = password?;

    let host = server_row
        .get("ip_address")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server missing ip_address".into()))?;
    let port = server_row
        .get("ssh_port")
        .and_then(json_i64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let ssh_user = server_row
        .get("ssh_user")
        .and_then(json_str)
        .unwrap_or_else(|| "root".into());

    // Всё нужное из кэша забрали — держать SQLCipher открытым по SSH незачем.
    drop(conn);

    let session = ssh_connect_session_with_timeout(
        &app,
        &host,
        port,
        &ssh_user,
        &password,
        LOG_TAIL_SESSION_TIMEOUT,
    )
    .await;
    // Пароль сервера дальше не нужен ни на успешном пути, ни на ошибочном.
    password.zeroize();
    // `HOST_KEY_UNKNOWN` уходит наверх той же строкой-сентинелом, что и у
    // соседей: это не отказ, а «подтверди ключ хоста и повтори». Ничего
    // фиксировать не надо — фиксировать здесь вообще нечего.
    let mut session = session?;

    // Бинарь панели (`get_fastpanel_path`) здесь не нужен: файл читается
    // напрямую. CLI FastPanel логи не отдаёт вовсе (разведка 2026-08-19).
    let tail = read_log_tail(&mut session, &path).await;
    let _ = session.disconnect().await;

    // Провал отдаётся наружу полным текстом: пароля в argv этой команды нет
    // (мы читаем, а не создаём), значит скрывать в ней нечего. Наружу — это
    // только в десктоп; на сервер по-прежнему не уходит ничего.
    tail.map_err(CommandError::from)
}

/// Стоит ли `path` в снимке домена среди `fp_facts.logs[].path`.
///
/// Вынесено чистой функцией ради теста: сама команда неюнит-тестируема (ей нужны
/// keychain, кэш и SSH), а решение «пускать или нет» проверять обязательно.
///
/// Сравнение точное и регистрозависимое: пути в Linux регистрозависимы, и
/// «почти совпал» — это не совпал. Никакой нормализации (`..`, симлинки,
/// префикс каталога) здесь нет намеренно — список замкнутый, сверяем членство,
/// а не форму строки.
///
/// `fp_facts` в кэше приезжает то объектом, то строкой JSON — как ляжет
/// сериализация колонки на стороне синка. Разбираем оба вида честно, а не
/// надеемся на один: молчаливое `false` на строковом виде выглядело бы как
/// «путь чужой» и отвергало бы законные чипы.
fn path_is_known(facts: Option<&serde_json::Value>, path: &str) -> bool {
    let Some(raw) = facts else {
        return false;
    };
    let parsed;
    let facts = match raw.as_str() {
        Some(s) => {
            parsed = match serde_json::from_str::<serde_json::Value>(s) {
                Ok(v) => v,
                Err(_) => return false,
            };
            &parsed
        }
        None => raw,
    };
    facts
        .get("logs")
        .and_then(|l| l.as_array())
        .is_some_and(|logs| {
            logs.iter()
                .any(|f| f.get("path").and_then(|p| p.as_str()) == Some(path))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::fastpanel_logs::LOG_TAIL_EXEC_TIMEOUT;

    // inactivity сессии заведомо больше exec-бюджета единственной команды —
    // иначе russh закрыл бы канал раньше, чем истёк бы честный таймаут чтения.
    // Образец — `session_timeout_exceeds_the_read_exec_budget` у снимка.
    #[test]
    fn session_timeout_exceeds_the_tail_exec_budget() {
        assert!(
            LOG_TAIL_SESSION_TIMEOUT > LOG_TAIL_EXEC_TIMEOUT,
            "session {LOG_TAIL_SESSION_TIMEOUT:?} must exceed exec {LOG_TAIL_EXEC_TIMEOUT:?}"
        );
    }

    const FACTS: &str = r#"{
      "logs": [
        {"path": "/var/www/u_usr/data/logs/site.com-frontend.access.log", "exists": true, "size_bytes": 100},
        {"path": "/var/www/u_usr/data/logs/site.com-backend.error.log", "exists": false}
      ]
    }"#;

    fn facts_value() -> serde_json::Value {
        serde_json::from_str(FACTS).unwrap()
    }

    #[test]
    fn path_is_known_accepts_a_path_from_the_snapshot() {
        let v = facts_value();
        assert!(path_is_known(
            Some(&v),
            "/var/www/u_usr/data/logs/site.com-frontend.access.log"
        ));
        // `exists: false` — всё равно наш путь: гейт про членство в списке, а
        // «файла нет» скажет уже сама команда маркером `#sdmp:missing`.
        assert!(path_is_known(
            Some(&v),
            "/var/www/u_usr/data/logs/site.com-backend.error.log"
        ));
    }

    #[test]
    fn path_is_known_rejects_a_foreign_path() {
        let v = facts_value();
        assert!(!path_is_known(Some(&v), "/etc/shadow"));
        assert!(!path_is_known(
            Some(&v),
            "/var/www/other_usr/data/logs/site.com-frontend.access.log"
        ));
    }

    // Пути в Linux регистрозависимы: «почти совпал» — это не совпал.
    #[test]
    fn path_is_known_is_case_sensitive() {
        let v = facts_value();
        assert!(!path_is_known(
            Some(&v),
            "/var/www/u_usr/data/logs/site.com-Frontend.access.log"
        ));
    }

    // Снимок, снятый до появления `logs` в контракте, приезжает без поля — и
    // отвергает всё. Правильно: чипов на таком снимке тоже нет.
    #[test]
    fn path_is_known_rejects_a_snapshot_without_logs() {
        let v: serde_json::Value = serde_json::from_str(r#"{"databases": ["a"]}"#).unwrap();
        assert!(!path_is_known(Some(&v), "/var/log/nginx/access.log"));
        assert!(!path_is_known(Some(&serde_json::Value::Null), "/x"));
        assert!(!path_is_known(None, "/x"));
    }

    // Тот же снимок, приехавший строкой JSON, обязан читаться так же.
    #[test]
    fn path_is_known_reads_facts_stored_as_a_json_string() {
        let as_string = serde_json::Value::String(FACTS.to_string());
        assert!(path_is_known(
            Some(&as_string),
            "/var/www/u_usr/data/logs/site.com-frontend.access.log"
        ));
        assert!(!path_is_known(Some(&as_string), "/etc/shadow"));
        // Строка, которая не JSON, — не снимок, а мусор: пускать нечего.
        assert!(!path_is_known(
            Some(&serde_json::Value::String("not json".into())),
            "/x"
        ));
    }
}
