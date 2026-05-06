use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::State;

use crate::commands::auth::CommandError;
use crate::crypto::aead;
use crate::keychain;
use crate::sync::http::ApiClient;

#[tauri::command]
pub async fn vault_decrypt_blob(
    user_id: String,
    blob_id: String,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let blob = api
        .blob_get(&blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let raw = B64
        .decode(blob.ciphertext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    let plaintext = aead::decrypt(&raw, &key)?;
    Ok(B64.encode(&plaintext))
}

#[tauri::command]
pub async fn vault_put_blob(
    user_id: String,
    blob_id: String,
    blob_kind: String,
    plaintext_b64: String,
    api: State<'_, ApiClient>,
) -> Result<(), CommandError> {
    let key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let pt = B64
        .decode(plaintext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    let ct = aead::encrypt(&pt, &key)?;
    api.blob_put(&blob_id, &blob_kind, &ct)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn vault_delete_blob(blob_id: String, api: State<'_, ApiClient>) -> Result<(), CommandError> {
    api.blob_delete(&blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}
