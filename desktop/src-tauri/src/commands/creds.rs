//! Общие helper'ы для Tauri-команд: расшифровка blob'ов и доступ к локальному кэшу.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::State;

use crate::commands::auth::CommandError;
use crate::commands::sync_cmd::SyncHandle;
use crate::crypto::aead;
use crate::sync::http::ApiClient;

/// Забрать зашифрованный blob по id и расшифровать его master-key'ом.
pub(crate) async fn blob_plaintext(
    api: &ApiClient,
    key: &[u8; 32],
    blob_id: &str,
) -> Result<Vec<u8>, CommandError> {
    let blob = api
        .blob_get(blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let raw = B64
        .decode(blob.ciphertext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    aead::decrypt(&raw, key).map_err(|e| CommandError::Aead(e.to_string()))
}

pub(crate) fn json_str(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

pub(crate) fn json_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_u64().map(|u| u as i64))
}

/// Путь к локальному кэшу из инициализированного `SyncHandle`.
pub(crate) fn cache_path(handle: &State<'_, SyncHandle>) -> Result<PathBuf, CommandError> {
    let g = handle.0.lock().map_err(|e| CommandError::Api(e.to_string()))?;
    let c = g
        .as_ref()
        .ok_or_else(|| CommandError::Api("sync not initialized".into()))?;
    Ok(c.cache_path.clone())
}
