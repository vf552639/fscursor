use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::auth::CommandError;
use crate::commands::ssh::ssh_connect_session;
use crate::commands::sync_cmd::SyncHandle;
use crate::crypto::aead;
use crate::keychain;
use crate::provision::bulk;
use crate::ssh::fastpanel::{self, CreateSiteResult};
use crate::sync::cache;
use crate::sync::http::ApiClient;

#[derive(Serialize)]
pub struct ProvisionResultOut {
    pub domain_id: String,
    pub site_user: String,
    pub site_path: String,
}

async fn blob_plaintext(api: &ApiClient, key: &[u8; 32], blob_id: &str) -> Result<Vec<u8>, CommandError> {
    let blob = api
        .blob_get(blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let raw = B64
        .decode(blob.ciphertext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    aead::decrypt(&raw, key).map_err(|e| CommandError::Aead(e.to_string()))
}

fn json_str(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

fn json_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_u64().map(|u| u as i64))
}

pub async fn run_provision_domain(
    app: &AppHandle,
    user_id: &str,
    domain_id: &str,
    site_only: bool,
    cache_path: &Path,
    api: &ApiClient,
) -> Result<ProvisionResultOut, CommandError> {
    let key = keychain::load_master_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let conn = cache::open(cache_path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let domain_row = cache::get_row_fields(&conn, "domains", domain_id)
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

    let password = blob_plaintext(api, &key, &blob_id).await?;
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
    let php_version = domain_row
        .get("php_version")
        .and_then(json_str)
        .unwrap_or_else(|| "8.1".into());

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "ssh_connect", "domain_id": domain_id }),
    );

    let mut session = ssh_connect_session(app, &host, port, &ssh_user, &password).await?;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "fastpanel_path", "domain_id": domain_id }),
    );
    let fp_path = fastpanel::get_fastpanel_path(&mut session, None)
        .await?
        .ok_or_else(|| CommandError::Api("fastpanel binary not found on server".into()))?;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "firewall_preflight", "domain_id": domain_id }),
    );
    let ports = fastpanel::ensure_ports_open(&mut session, &[80, 443]).await?;
    if !ports.success {
        tracing::warn!(target: "provision", "firewall preflight: {:?}", ports.error);
    }

    let site_user_existing = domain_row.get("site_user").and_then(json_str);
    let CreateSiteResult {
        site_user,
        site_path,
        ..
    } = if let Some(ref u) = site_user_existing {
        if fastpanel::site_exists(&mut session, u, &domain_name).await? {
            CreateSiteResult {
                site_user: u.clone(),
                site_path: format!("/var/www/{u}/data/www/{domain_name}"),
                output: "already exists".into(),
            }
        } else {
            fastpanel::create_site(&mut session, &fp_path, &domain_name, &php_version).await?
        }
    } else {
        fastpanel::create_site(&mut session, &fp_path, &domain_name, &php_version).await?
    };

    if !site_only {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "ftp", "domain_id": domain_id }),
        );
        let _ftp = fastpanel::create_ftp_account(&mut session, &fp_path, &domain_name).await?;
    }

    let _ = session.disconnect().await;

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    api.audit_log(
        "device.action.complete",
        Some("domain"),
        Some(domain_id),
        device_id,
        Some(serde_json::json!({
            "steps": ["ssh", "create_site"],
            "domain_name": domain_name,
            "server_id": server_id,
            "site_only": site_only,
        })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;

    Ok(ProvisionResultOut {
        domain_id: domain_id.to_string(),
        site_user,
        site_path,
    })
}

#[tauri::command]
pub async fn provision_domain(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    site_only: bool,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<ProvisionResultOut, CommandError> {
    let cache_path = {
        let g = handle.0.lock().map_err(|e| CommandError::Api(e.to_string()))?;
        let c = g
            .as_ref()
            .ok_or_else(|| CommandError::Api("sync not initialized".into()))?;
        c.cache_path.clone()
    };
    run_provision_domain(&app, &user_id, &domain_id, site_only, &cache_path, &api).await
}

#[tauri::command]
pub async fn provision_bulk(
    app: AppHandle,
    user_id: String,
    domain_ids: Vec<String>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let key = idempotency_key("provision_bulk", &domain_ids);
    let cache_path = {
        let g = handle.0.lock().map_err(|e| CommandError::Api(e.to_string()))?;
        let c = g
            .as_ref()
            .ok_or_else(|| CommandError::Api("sync not initialized".into()))?;
        c.cache_path.clone()
    };
    let mk = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let conn = cache::open(&cache_path, &mk).map_err(|e| CommandError::Api(e.to_string()))?;

    if let Some((st, _)) =
        cache::bulk_run_status(&conn, &key).map_err(|e| CommandError::Api(e.to_string()))?
    {
        if st == "running" || st == "done" {
            return Ok(key);
        }
    }
    cache::bulk_run_upsert_start(
        &conn,
        &key,
        "provision_bulk",
        &serde_json::to_string(&domain_ids).unwrap_or_default(),
    )
    .map_err(|e| CommandError::Api(e.to_string()))?;

    for did in &domain_ids {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "bulk_item", "domain_id": did }),
        );
        run_provision_domain(&app, &user_id, did, false, &cache_path, &api).await?;
    }
    cache::bulk_run_complete(&conn, &key, "ok").map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(key)
}

fn idempotency_key(action: &str, domain_ids: &[String]) -> String {
    bulk::idempotency_key(action, domain_ids)
}

#[tauri::command]
pub async fn install_fastpanel(
    _app: AppHandle,
    _server_id: String,
    _force: bool,
) -> Result<(), CommandError> {
    Err(CommandError::Api(
        "install_fastpanel not yet implemented (stage 3 partial)".into(),
    ))
}
