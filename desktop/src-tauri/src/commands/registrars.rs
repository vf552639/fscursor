//! Tauri-команды регистраторов (Hostiq/Namecheap). API-ключ/секрет расшифровываются
//! на клиенте; смена NS пишется в audit_log — best-effort, см.
//! `creds::audit_best_effort`.

use tauri::{AppHandle, State};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::commands::auth::CommandError;
use crate::commands::creds::{audit_best_effort, blob_plaintext, cache_path, json_str};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::registrars::{self, DomainInfo, RegistrarService};
use crate::sync::cache;
use crate::sync::http::ApiClient;

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

#[tauri::command]
pub async fn registrar_set_nameservers(
    app: AppHandle,
    user_id: String,
    account_id: String,
    domain: String,
    nameservers: Vec<String>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<bool, CommandError> {
    let (svc, device_id) = reg_service(&api, &user_id, &handle, &account_id).await?;
    let ok = svc
        .set_nameservers(&domain, &nameservers)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    // NS у регистратора уже переписаны, и делегирование поехало. `?` из-за сбоя
    // аудита показал бы неудачу на удавшейся смене, а повтор ничего бы не
    // исправил. Best-effort, не превращать обратно в `?`.
    audit_best_effort(
        &app,
        &api,
        "registrar.ns_set",
        "domain",
        &domain,
        device_id,
        Some(serde_json::json!({ "nameservers": nameservers })),
    )
    .await;
    Ok(ok)
}
