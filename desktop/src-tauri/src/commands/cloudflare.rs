//! Tauri-команды Cloudflare. Токен CF-аккаунта расшифровывается на клиенте,
//! операции идут напрямую в Cloudflare API v4. Каждая мутация пишется в audit_log.

use serde::Deserialize;
use tauri::State;
use uuid::Uuid;

use crate::cloudflare::client::{self, DnsRecord, DnsRecordPatch, DnsRecordPayload, Zone};
use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_str};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::sync::cache;
use crate::sync::http::ApiClient;

/// Контекст CF-аккаунта: расшифрованный токен, CF account_id (для create_zone),
/// device_id (для audit).
struct CfCtx {
    token: String,
    cf_account_id: Option<String>,
    device_id: Option<Uuid>,
}

async fn cf_ctx(
    api: &ApiClient,
    user_id: &str,
    handle: &State<'_, SyncHandle>,
    account_id: &str,
) -> Result<CfCtx, CommandError> {
    let key = keychain::load_master_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let row = cache::get_row_fields(&conn, "cloudflare_accounts", account_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("cloudflare account not in local cache".into()))?;

    let blob_id = row
        .get("api_token_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("account has no api_token_blob_id".into()))?;
    let token_bytes = blob_plaintext(api, &key, &blob_id).await?;
    let token =
        String::from_utf8(token_bytes).map_err(|_| CommandError::Aead("token not utf8".into()))?;

    let cf_account_id = row.get("account_id").and_then(json_str);
    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    Ok(CfCtx {
        token,
        cf_account_id,
        device_id,
    })
}

#[derive(Deserialize)]
pub struct DnsRecordInput {
    #[serde(rename = "type")]
    pub record_type: String,
    pub name: String,
    pub content: String,
    pub ttl: Option<u32>,
    pub proxied: Option<bool>,
}

#[derive(Deserialize)]
pub struct DnsRecordPatchInput {
    pub name: Option<String>,
    pub content: Option<String>,
    pub ttl: Option<u32>,
    pub proxied: Option<bool>,
}

#[tauri::command]
pub async fn cf_verify_token(
    user_id: String,
    account_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<bool, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::verify_token(&ctx.token)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

#[tauri::command]
pub async fn cf_create_zone(
    user_id: String,
    account_id: String,
    zone_name: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<Zone, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    let (zone, created) = client::create_zone(&ctx.token, &zone_name, ctx.cf_account_id.as_deref())
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    if created {
        api.audit_log(
            "cf.zone.create",
            Some("cloudflare_zone"),
            Some(&zone.id),
            ctx.device_id,
            Some(serde_json::json!({ "name": zone.name })),
        )
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    }
    Ok(zone)
}

#[tauri::command]
pub async fn cf_create_dns_record(
    user_id: String,
    account_id: String,
    zone_id: String,
    record: DnsRecordInput,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<DnsRecord, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    let payload = DnsRecordPayload {
        record_type: record.record_type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
    };
    let rec = client::create_dns_record(&ctx.token, &zone_id, &payload)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    api.audit_log(
        "cf.dns.create",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        Some(serde_json::json!({ "type": rec.record_type, "name": rec.name })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(rec)
}

#[tauri::command]
pub async fn cf_update_dns_record(
    user_id: String,
    account_id: String,
    zone_id: String,
    record_id: String,
    patch: DnsRecordPatchInput,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<DnsRecord, CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    let p = DnsRecordPatch {
        name: patch.name,
        content: patch.content,
        ttl: patch.ttl,
        proxied: patch.proxied,
    };
    let rec = client::update_dns_record(&ctx.token, &zone_id, &record_id, &p)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    api.audit_log(
        "cf.dns.update",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        Some(serde_json::json!({ "record_id": record_id })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(rec)
}

#[tauri::command]
pub async fn cf_delete_dns_record(
    user_id: String,
    account_id: String,
    zone_id: String,
    record_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<(), CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::delete_dns_record(&ctx.token, &zone_id, &record_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    api.audit_log(
        "cf.dns.delete",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        Some(serde_json::json!({ "record_id": record_id })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn cf_purge_cache(
    user_id: String,
    account_id: String,
    zone_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<(), CommandError> {
    let ctx = cf_ctx(&api, &user_id, &handle, &account_id).await?;
    client::purge_cache(&ctx.token, &zone_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    api.audit_log(
        "cf.cache_purge",
        Some("cloudflare_zone"),
        Some(&zone_id),
        ctx.device_id,
        None,
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(())
}
