//! Tauri-команда чтения состояния домена с сервера (`domain_read_facts`).
//!
//! Форма — как у `server_list_sites`/`install_fastpanel` (`commands::provision`):
//! резолв домена и сервера из локального кэша, расшифровка SSH-блоба, `zeroize`
//! пароля сразу после `connect`, ОДНА сессия на весь снимок, обработка
//! `HOST_KEY_UNKNOWN` внутри `ssh_connect_session_with_timeout`. Отличие —
//! write-back: результат уходит и наружу (во фронт, чтобы UI не ждал ресинка), и
//! на сервер (`POST /domains/{id}/facts`), откуда он ложится в БД и виден в
//! read-only вебе. Аудит `domain.read_facts` пишет сам роут при этом POST'е
//! (phase 1), поэтому отдельного `audit_log` здесь нет — иначе действие
//! задвоилось бы в журнале.

use std::time::Duration;

use tauri::{AppHandle, State};
use zeroize::Zeroize;

use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_i64, json_str};
use crate::commands::ssh::ssh_connect_session_with_timeout;
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::ssh::fastpanel;
use crate::ssh::fastpanel_facts::{self, DomainFacts};
use crate::sync::cache;
use crate::sync::http::ApiClient;

/// Через сколько молчания считаем сессию чтения оборванной.
///
/// Заведомо больше суммы exec-бюджета снимка (`FACTS_EXEC_TIMEOUT ×
/// FACTS_READ_COMMANDS`): inactivity убивает не команду, а всю СЕССИЮ, и, закрой
/// russh канал посреди снимка, следующий факт упал бы намертво, потеряв уже
/// прочитанное. Соотношение закреплено тестом ниже — как у `SSL_ISSUE_EXEC_TIMEOUT`
/// против `PROVISION_SESSION_TIMEOUT`.
const FACTS_SESSION_TIMEOUT: Duration = Duration::from_secs(600);

/// Что уходит на СЕРВЕР о неудачном чтении — обезличенный класс, без сырого
/// вывода команд. Полный текст (для починки) остаётся на десктопе в возвращённой
/// ошибке; серверу зеро-нолидж, поэтому только эта константа.
const FACTS_READ_FAILED: &str = "could not read domain facts over ssh";

/// Строка-маркер «нужно подтверждение ключа хоста», которую кладёт
/// `ssh_connect_session_with_timeout` в `CommandError::Api`. Держим одним
/// значением, чтобы `is_host_key_unknown` и фронт различали её одинаково.
const HOST_KEY_UNKNOWN_SENTINEL: &str = "HOST_KEY_UNKNOWN";

/// Прочитать состояние домена с сервера по SSH и записать снимок — ТОЛЬКО
/// чтение, без мутаций сервера.
///
/// Наверх возвращается `DomainFacts` и одновременно уходит write-back'ом на
/// сервер (оба — чтобы UI не ждал ресинка). Провал чтения после установленного
/// соединения фиксируется на сервере телом `{error}` (снимок при этом НЕ
/// трогается — провал не молодит и не стирает последний хороший), а наружу
/// возвращается полный текст. Ошибки самого соединения (в т.ч. `HOST_KEY_UNKNOWN`)
/// проходят наверх как есть, как в `server_list_sites`, и снимок не трогают.
#[tauri::command]
pub async fn domain_read_facts(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<DomainFacts, CommandError> {
    let mut key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(&handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let domain_row = cache::get_row_fields(&conn, "domains", &domain_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("domain not in local cache".into()))?;

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
    // Мастер-ключ дальше не нужен: только SSH и HTTP. Гасим до разбора результата.
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

    let domain_name = domain_row
        .get("domain_name")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("domain missing domain_name".into()))?;
    // Известный системный пользователь сайта — фоллбэк для путей логов, если в
    // `sites list --json` владелец почему-то не назван.
    let site_user = domain_row.get("site_user").and_then(json_str);

    // Всё нужное из кэша забрали — держать SQLCipher открытым по SSH незачем.
    // Аудит пишет серверный роут `POST /domains/{id}/facts`, отдельного
    // `device_id` десктопу здесь не нужно.
    drop(conn);

    let session = ssh_connect_session_with_timeout(
        &app,
        &host,
        port,
        &ssh_user,
        &password,
        FACTS_SESSION_TIMEOUT,
    )
    .await;
    // Пароль сервера дальше не нужен ни на успешном пути, ни на ошибочном.
    password.zeroize();
    let mut session = match session {
        Ok(s) => s,
        Err(e) => {
            // Провал самого коннекта (TCP refused, auth) — это НАСТОЯЩИЙ провал
            // попытки, и он обязан быть виден в вебе (принцип №6): фиксируем на
            // сервере телом `{error}` — `apply_facts` подвинет `fp_checked_at` и
            // запишет `fp_check_error`, снимок не тронув. Иначе лежачий сервер
            // выглядел бы как «давно не проверяли».
            //
            // Исключение — `HOST_KEY_UNKNOWN`: это не отказ, а «нужен ключ хоста».
            // Его проброс оставляем как есть, без фиксации провала: пользователь
            // подтвердит ключ и повторит. Различаем по тексту, как это делает
            // фронт (`ssh_connect_session_with_timeout` кладёт именно эту строку).
            if !is_host_key_unknown(&e) {
                record_facts_error(&api, &domain_id).await;
            }
            return Err(e);
        }
    };

    // Бинарь панели ищем как везде (`get_fastpanel_path`). Без него снимок снять
    // нечем — это неудача чтения, а не «домена нет».
    let fp = fastpanel::get_fastpanel_path(&mut session, None).await;
    let facts_result = match fp {
        Ok(Some(fp)) => fastpanel_facts::read_domain_facts(
            &mut session,
            &fp,
            &domain_name,
            site_user.as_deref(),
        )
        .await
        .map_err(CommandError::from),
        Ok(None) => Err(CommandError::Api(
            "fastpanel is not installed on the server".into(),
        )),
        Err(e) => Err(CommandError::from(e)),
    };
    let _ = session.disconnect().await;

    match facts_result {
        Ok(facts) => {
            // Write-back снимка — best-effort: снимок уже наверху, ронять команду
            // из-за сетевого сбоя на последнем шаге незачем. Сам этот POST и есть
            // запись аудита `domain.read_facts` на сервере.
            let facts_value = serde_json::to_value(&facts)
                .map_err(|e| CommandError::Api(e.to_string()))?;
            let body = serde_json::json!({ "facts": facts_value });
            if let Err(e) = api.domain_facts_write_back(&domain_id, &body).await {
                tracing::warn!(target: "facts", "write-back of domain facts failed: {e}");
            }
            Ok(facts)
        }
        Err(e) => {
            // Провал чтения после установленного коннекта — фиксируем на сервере
            // телом `{error}` (снимок не трогаем), наружу отдаём полный текст.
            record_facts_error(&api, &domain_id).await;
            Err(e)
        }
    }
}

/// `HOST_KEY_UNKNOWN` — не отказ, а «нужно подтверждение ключа хоста».
///
/// `ssh_connect_session_with_timeout` схлопывает этот случай в
/// `CommandError::Api("HOST_KEY_UNKNOWN")` (и шлёт фронту `ssh:host-key-prompt`);
/// по этой же строке фронт узнаёт его. Отдельный класс, чтобы не записать провал
/// туда, где провала нет.
fn is_host_key_unknown(e: &CommandError) -> bool {
    matches!(e, CommandError::Api(m) if m == HOST_KEY_UNKNOWN_SENTINEL)
}

/// Зафиксировать неудачную попытку на сервере (`{error}`), best-effort.
///
/// Снимок (`fp_facts`/`fp_facts_at`) роут при этом не трогает — двигаются только
/// `fp_checked_at` и `fp_check_error`. Провал самой записи не роняет команду
/// поверх исходной ошибки: пишем варнинг и идём дальше (как write-back везде).
async fn record_facts_error(api: &ApiClient, domain_id: &str) {
    let body = serde_json::json!({ "error": FACTS_READ_FAILED });
    if let Err(we) = api.domain_facts_write_back(domain_id, &body).await {
        tracing::warn!(target: "facts", "write-back of facts error failed: {we}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::fastpanel_facts::{FACTS_EXEC_TIMEOUT, FACTS_READ_COMMANDS};

    // inactivity сессии заведомо больше суммы exec-бюджета снимка — иначе russh
    // закрыл бы канал посреди снимка, и следующий факт упал бы намертво, потеряв
    // уже прочитанное. Образец — тест соотношения `SSL_ISSUE_EXEC_TIMEOUT`.
    #[test]
    fn session_timeout_exceeds_the_read_exec_budget() {
        assert!(
            FACTS_SESSION_TIMEOUT > FACTS_EXEC_TIMEOUT * FACTS_READ_COMMANDS,
            "session {FACTS_SESSION_TIMEOUT:?} must exceed {FACTS_READ_COMMANDS} × {FACTS_EXEC_TIMEOUT:?}"
        );
    }

    // Ветвление правки #2: только `HOST_KEY_UNKNOWN` — не провал (его проброс без
    // фиксации), всё прочее — настоящий провал коннекта, который надо записать.
    // Полный путь через SSH/keychain/кэш мокать тяжело — проверяется живым
    // прогоном; здесь закреплено само различение.
    #[test]
    fn only_host_key_unknown_is_not_a_failure() {
        assert!(is_host_key_unknown(&CommandError::Api(
            "HOST_KEY_UNKNOWN".into()
        )));
        assert!(!is_host_key_unknown(&CommandError::Api(
            "connect: connection refused".into()
        )));
        assert!(!is_host_key_unknown(&CommandError::Ssh("auth failed".into())));
    }
}
