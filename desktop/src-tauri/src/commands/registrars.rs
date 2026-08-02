//! Tauri-команды регистраторов (Hostiq/Namecheap). API-ключ/секрет расшифровываются
//! на клиенте; смена NS пишется в audit_log.

use tauri::State;
use uuid::Uuid;

use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_str};
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
    let key = keychain::load_master_key(user_id)
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
    let api_key =
        String::from_utf8(api_key_bytes).map_err(|_| CommandError::Aead("api_key not utf8".into()))?;

    // api_secret опционален: для Namecheap этот параметр используется как whitelisted client IP.
    let api_secret = match row.get("api_secret_blob_id").and_then(json_str) {
        Some(blob) => {
            let bytes = blob_plaintext(api, &key, &blob).await?;
            Some(String::from_utf8(bytes).map_err(|_| CommandError::Aead("api_secret not utf8".into()))?)
        }
        None => None,
    };

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    let svc = registrars::make_service(&provider, &api_key, api_user.as_deref(), api_secret.as_deref())
        .map_err(|e| CommandError::Api(e.to_string()))?;
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
    api.audit_log(
        "registrar.ns_set",
        Some("domain"),
        Some(&domain),
        device_id,
        Some(serde_json::json!({ "nameservers": nameservers })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(ok)
}
