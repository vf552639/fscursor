//! Tauri-команды регистраторов (Hostiq/Namecheap). API-ключ/секрет расшифровываются
//! на клиенте; смена NS пишет `ns_status` обратно в строку домена и строчку в
//! audit_log — и то и другое best-effort, см. `creds::audit_best_effort`.

use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::commands::auth::CommandError;
use crate::commands::creds::{
    audit_best_effort, blob_plaintext, cache_path, json_str, AUDIT_PROGRESS_EVENT,
};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::registrars::{self, DomainInfo, RegistrarError, RegistrarService};
use crate::sync::cache;
use crate::sync::http::{ApiClient, DomainWriteBack};

/// Собрать RegistrarService из кэшированной строки registrar_accounts + вернуть device_id.
async fn reg_service(
    api: &ApiClient,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
) -> Result<(Box<dyn RegistrarService>, Option<Uuid>), CommandError> {
    let mut key = keychain::load_master_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let row = cache::get_row_fields(&conn, "registrar_accounts", account_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("registrar account not in local cache".into()))?;

    let provider = row
        .get("provider")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("registrar account has no provider".into()))?;
    let api_user = row.get("api_user").and_then(json_str);

    let api_key_blob = row
        .get("api_key_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("registrar account has no api_key_blob_id".into()))?;
    let api_key_bytes = blob_plaintext(api, &key, &api_key_blob).await?;
    let mut api_key = String::from_utf8(api_key_bytes)
        .map_err(|_| CommandError::Aead("api_key not utf8".into()))?;

    // api_secret опционален: для Namecheap этот параметр используется как whitelisted client IP.
    let secret_blob = row.get("api_secret_blob_id").and_then(json_str);
    let mut api_secret = match secret_blob {
        Some(blob) => {
            let bytes = blob_plaintext(api, &key, &blob).await;
            // Мастер-ключ отработал оба блоба и больше не нужен. Гасим до
            // разбора результата, а не после, — иначе ошибочный путь его
            // пропустит.
            key.zeroize();
            let bytes = bytes?;
            Some(
                String::from_utf8(bytes)
                    .map_err(|_| CommandError::Aead("api_secret not utf8".into()))?,
            )
        }
        None => {
            key.zeroize();
            None
        }
    };

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    let svc = registrars::make_service(
        &provider,
        &api_key,
        api_user.as_deref(),
        api_secret.as_deref(),
    );
    // Свою копию ключа и секрета сервис уже забрал; наши расшифрованные строки
    // отжили своё. Гасим до `?`, чтобы ошибка `make_service` их не пропустила.
    api_key.zeroize();
    if let Some(s) = api_secret.as_mut() {
        s.zeroize();
    }
    let svc = svc.map_err(|e| CommandError::Api(e.to_string()))?;
    Ok((svc, device_id))
}

#[tauri::command]
pub async fn registrar_test_connection(
    user_id: String,
    account_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<(bool, String), CommandError> {
    let (svc, _) = reg_service(&api, &user_id, &handle, &account_id).await?;
    svc.test_connection()
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

#[tauri::command]
pub async fn registrar_get_domains(
    user_id: String,
    account_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Vec<DomainInfo>, CommandError> {
    let (svc, _) = reg_service(&api, &user_id, &handle, &account_id).await?;
    svc.get_domains()
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

/// Словарь `domains.ns_status`. Enum'а под него на бэкенде НЕТ: колонка —
/// голый `String(32)` (`models/domain.py`), и ни один серверный путь в неё не
/// пишет. Не искать `NsStatus` в `core/constants.py` — там есть `DomainStatus`
/// с `ns_pending`/`ns_ok`, но это ДРУГАЯ колонка (`domains.status`).
///
/// Фактический источник правды — фронт, который по этим значениям рисует бейдж
/// «NS push to registrar»: `ok` → зелёный, `error` → красный, всё остальное →
/// «Pending» (`Domains.tsx`, `Dashboard.tsx`, `ServerDetail.tsx`).
const NS_STATUS_OK: &str = "ok";
const NS_STATUS_ERROR: &str = "error";
/// Действие аудита смены NS. Оно же — ключ в `AUDIT_ACTION_LABEL` на фронте.
const AUDIT_ACTION_NS_SET: &str = "registrar.ns_set";

/// Что из итога смены NS уезжает на сервер.
///
/// Только статус: сами nameservers — это состояние зоны у Cloudflare и у
/// регистратора, дублировать его в строке домена нечем (колонки под список нет),
/// а `ns_updated_at` не заполняет ни один путь — ни серверный, ни этот.
///
/// Принимает ВЕСЬ итог, а не `bool`, ровно потому, что записать надо оба
/// исхода. Отказ регистратора (`Err`) — единственный достижимый провал: обе
/// реализации отвечают либо `Ok(true)`, либо ошибкой (`hostiq.rs`,
/// `namecheap.rs`). Если бы сюда приходил `bool` после `?`, `error` не писался
/// бы никогда, а домен с отбитой попыткой остался бы `pending` — то есть
/// «менять ещё не пробовали», что прямая ложь. `Ok(false)` — та же семантика
/// «не применил», просто сегодня недостижимая.
fn ns_write_back_body(outcome: &Result<bool, RegistrarError>) -> DomainWriteBack {
    let status = if ns_applied(outcome) {
        NS_STATUS_OK
    } else {
        NS_STATUS_ERROR
    };
    DomainWriteBack {
        ns_status: Some(status.to_string()),
        ..Default::default()
    }
}

/// Смена состоялась? Один предикат на всех, кто про это спрашивает: статус для
/// сервера, аудит и событие о провале write-back'а. Пока их было три штуки
/// врозь, аудит успел разойтись с остальными и записывал `Ok(false)` как
/// состоявшуюся смену.
fn ns_applied(outcome: &Result<bool, RegistrarError>) -> bool {
    matches!(outcome, Ok(true))
}

/// Прописать NS у регистратора.
///
/// `domain` — ИМЯ домена: его ждёт API регистратора, и оно же идёт в `target_id`
/// аудита. `domain_id` — строка `domains` на сервере, адресат write-back'а;
/// одно из другого не выводится, поэтому приходят оба.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn registrar_set_nameservers(
    app: AppHandle,
    user_id: String,
    account_id: String,
    domain_id: String,
    domain: String,
    nameservers: Vec<String>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<bool, CommandError> {
    let (svc, device_id) = reg_service(&api, &user_id, &handle, &account_id).await?;
    // Итог держим целиком и НЕ разворачиваем через `?` до write-back'а: отказ
    // регистратора — это как раз тот исход, ради которого `ns_status` и нужен.
    let outcome = svc.set_nameservers(&domain, &nameservers).await;

    // Write-back раньше аудита — как в провижининге. Без него `ns_status` домена
    // навсегда оставался бы `pending`: другого пути его заполнить нет (роутов
    // `check-ns`/`mark-ns-set` на бэкенде не существует), и бейдж «NS push to
    // registrar» врал бы — и про удавшуюся смену, и про отбитую попытку.
    //
    // Best-effort по той же причине, что и аудит: на успехе NS у регистратора
    // уже переписаны и откату не подлежат, а на провале пользователю нужен
    // текст ошибки регистратора, а не сообщение про незаписанный статус. Ни в
    // одну сторону не превращать в `?`: там он подменил бы собой настоящий
    // результат.
    if let Err(e) = api
        .domain_write_back(&domain_id, &ns_write_back_body(&outcome))
        .await
    {
        tracing::warn!(target: "registrars", "write-back of ns_status failed: {e}");
        // Событие — только когда смена состоялась. Текст на той стороне
        // склеивается из `AUDIT_ACTION_LABEL` («Nameservers set») и суффикса про
        // незаписанный результат; на отбитой попытке пользователь получил бы
        // тост «Nameservers set, but…» одновременно с баннером «Namecheap
        // setCustom failed: …» — два взаимоисключающих сообщения об одном
        // действии. Незаписанный `ns_status` на уже видимой ошибке — меньшее
        // зло: ошибка на экране, а не молчание.
        if ns_applied(&outcome) {
            let _ = app.emit(
                AUDIT_PROGRESS_EVENT,
                serde_json::json!({
                    "step": "writeback_failed",
                    "action": AUDIT_ACTION_NS_SET,
                    "target_type": "domain",
                    "target_id": domain,
                }),
            );
        }
    }

    // Только теперь наружу: ошибка регистратора доезжает до баннера модалки как
    // была, статус на сервере к этому моменту уже записан.
    let ok = outcome.map_err(|e| CommandError::Api(e.to_string()))?;

    // Аудит — только за состоявшуюся смену: строчка `registrar.ns_set` на
    // непринятом `Ok(false)` врала бы истории, а write-back и фронт этот же
    // случай трактуют как «не применено» (`ns_status: error`). `?` из-за сбоя
    // аудита показал бы неудачу на удавшейся смене, а повтор ничего бы не
    // исправил. Best-effort, не превращать обратно в `?`.
    if ok {
        audit_best_effort(
            &app,
            &api,
            AUDIT_ACTION_NS_SET,
            "domain",
            &domain,
            device_id,
            Some(serde_json::json!({ "nameservers": nameservers })),
        )
        .await;
    }
    Ok(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body_of(outcome: Result<bool, RegistrarError>) -> String {
        serde_json::to_string(&ns_write_back_body(&outcome)).unwrap()
    }

    #[test]
    fn ns_write_back_body_maps_success_to_ok() {
        assert_eq!(body_of(Ok(true)), r#"{"ns_status":"ok"}"#);
    }

    #[test]
    fn ns_write_back_body_maps_registrar_rejection_to_error() {
        // Единственный достижимый провал: обе реализации отвечают либо
        // `Ok(true)`, либо `Err`. Пока итог разворачивался через `?` до
        // write-back'а, именно этот случай не записывался вообще — домен с
        // отбитой попыткой оставался `pending`.
        let err = RegistrarError::Api("Namecheap setCustom failed: Invalid nameserver".into());
        assert_eq!(body_of(Err(err)), r#"{"ns_status":"error"}"#);
    }

    #[test]
    fn ns_write_back_body_maps_unapplied_to_error() {
        assert_eq!(body_of(Ok(false)), r#"{"ns_status":"error"}"#);
    }

    #[test]
    fn ns_applied_agrees_with_the_written_status() {
        // Аудит, статус и событие о провале write-back'а спрашивают об одном и
        // том же — «смена состоялась?». Пока аудит решал это сам (всё, что не
        // `Err`), он записывал `Ok(false)` как состоявшуюся смену, хотя на
        // сервер в этот момент уезжал `error`.
        for outcome in [
            Ok(true),
            Ok(false),
            Err(RegistrarError::Api("refused".into())),
        ] {
            let expected = if ns_applied(&outcome) {
                r#"{"ns_status":"ok"}"#
            } else {
                r#"{"ns_status":"error"}"#
            };
            assert_eq!(
                serde_json::to_string(&ns_write_back_body(&outcome)).unwrap(),
                expected
            );
        }
    }

    #[test]
    fn ns_write_back_body_touches_nothing_but_ns_status() {
        // Патч применяется как `exclude_unset`: лишнее поле здесь затёрло бы
        // чужой результат (например, `ssl_status`, который ставит провижининг).
        for outcome in [Ok(true), Ok(false), Err(RegistrarError::NotImplemented)] {
            let body: serde_json::Value =
                serde_json::to_value(ns_write_back_body(&outcome)).unwrap();
            let obj = body.as_object().unwrap();
            assert_eq!(obj.len(), 1, "лишние поля в патче: {obj:?}");
        }
    }
}
