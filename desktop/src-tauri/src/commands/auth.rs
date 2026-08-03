use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use tauri::State;

use crate::crypto::{aead, bip39_recovery, kdf};
use crate::keychain;
use crate::sync::http::{ApiClient, ApiError};

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("kdf: {0}")]
    Kdf(String),
    #[error("aead: {0}")]
    Aead(String),
    #[error("recovery: {0}")]
    Recovery(String),
    #[error("api: {0}")]
    Api(String),
    #[error("keychain: {0}")]
    Keychain(String),
    #[error("ssh: {0}")]
    Ssh(String),
}

impl From<crate::ssh::client::SshError> for CommandError {
    fn from(e: crate::ssh::client::SshError) -> Self {
        Self::Ssh(e.to_string())
    }
}

impl From<kdf::KdfError> for CommandError {
    fn from(e: kdf::KdfError) -> Self {
        Self::Kdf(e.to_string())
    }
}

impl From<aead::AeadError> for CommandError {
    fn from(e: aead::AeadError) -> Self {
        Self::Aead(e.to_string())
    }
}

impl From<bip39_recovery::RecoveryError> for CommandError {
    fn from(e: bip39_recovery::RecoveryError) -> Self {
        Self::Recovery(e.to_string())
    }
}

fn decode_salt16(salt_b64: &str) -> Result<[u8; 16], CommandError> {
    let bytes = B64
        .decode(salt_b64.as_bytes())
        .map_err(|_| CommandError::Kdf("invalid salt".into()))?;
    if bytes.len() != 16 {
        return Err(CommandError::Kdf("salt length".into()));
    }
    let mut a = [0u8; 16];
    a.copy_from_slice(&bytes);
    Ok(a)
}

/// Turn the recovery endpoints' status codes into something a user can act on.
/// 401 covers "wrong phrase" and "unknown email" alike — the backend refuses to tell
/// them apart on purpose, so neither does this message.
fn describe_recovery_error(e: ApiError) -> CommandError {
    match e {
        ApiError::Status { status: 401, .. } => CommandError::Api(
            "Recovery rejected: this phrase does not match that account. \
             Check the email address and all 24 words."
                .into(),
        ),
        ApiError::Status { status: 404, .. } | ApiError::Status { status: 409, .. } => {
            CommandError::Api(
                "This account has no recovery key configured (it predates the recovery-proof \
                 update). Sign in with your password and set recovery up again, then retry."
                    .into(),
            )
        }
        ApiError::Status { status: 429, .. } => CommandError::Api(
            "Too many recovery attempts. Wait a minute before trying again.".into(),
        ),
        other => CommandError::Api(other.to_string()),
    }
}

#[derive(Serialize)]
pub struct RegisterResult {
    pub user_id: String,
    pub recovery_phrase: String,
}

#[tauri::command]
pub async fn auth_register(
    email: String,
    password: String,
    api: State<'_, ApiClient>,
) -> Result<RegisterResult, CommandError> {
    let salt = kdf::random_salt();
    let auth_key = kdf::derive_auth_key(password.as_bytes(), &salt)?;
    let master_key = kdf::derive_master_key(password.as_bytes(), &salt)?;
    let phrase = bip39_recovery::generate_phrase();
    let recovery_blob = bip39_recovery::wrap_master_key(&master_key.0, &phrase)?;
    let recovery_auth_key = kdf::derive_recovery_auth_key(&phrase)?;
    let resp = api
        .register(
            &email,
            &salt,
            &auth_key.0,
            &recovery_blob,
            &recovery_auth_key.0,
        )
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::store_master_key(&resp.user_id, &master_key.0).map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(RegisterResult {
        user_id: resp.user_id,
        recovery_phrase: phrase,
    })
}

#[tauri::command]
pub async fn auth_login(
    email: String,
    password: String,
    totp_code: Option<String>,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let start = api
        .login_start(&email)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let salt = decode_salt16(&start.salt_b64)?;
    let auth_key = kdf::derive_auth_key(password.as_bytes(), &salt)?;
    let master_key = kdf::derive_master_key(password.as_bytes(), &salt)?;
    let resp = api
        .login_finish(&email, &auth_key.0, totp_code.as_deref())
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::store_master_key(&resp.user_id, &master_key.0).map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(resp.user_id)
}

#[tauri::command]
pub async fn auth_logout(user_id: String, api: State<'_, ApiClient>) -> Result<(), CommandError> {
    api.logout().await.map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::forget_master_key(&user_id).map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(())
}

/// (Re)configure recovery for the signed-in account: mint a fresh 24-word phrase, rewrap
/// the master key under it and register the new proof key. This is what the 409 from
/// `/auth/recovery/finish` tells legacy accounts (NULL hash, registered before migration
/// 014) to do. Requires the master password as a step-up.
///
/// NOTE: no UI calls this yet — see the phase report.
#[tauri::command]
pub async fn auth_recovery_setup(
    password: String,
    api: State<'_, ApiClient>,
) -> Result<RegisterResult, CommandError> {
    let me = api.me().await.map_err(|e| CommandError::Api(e.to_string()))?;
    let start = api
        .login_start(&me.email)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let salt = decode_salt16(&start.salt_b64)?;
    let auth_key = kdf::derive_auth_key(password.as_bytes(), &salt)?;
    let master_key = kdf::derive_master_key(password.as_bytes(), &salt)?;
    let phrase = bip39_recovery::generate_phrase();
    let recovery_blob = bip39_recovery::wrap_master_key(&master_key.0, &phrase)?;
    let recovery_auth_key = kdf::derive_recovery_auth_key(&phrase)?;
    api.recovery_setup(&auth_key.0, &recovery_blob, &recovery_auth_key.0)
        .await
        .map_err(|e| match e {
            ApiError::Status { status: 401, .. } => {
                CommandError::Api("Wrong master password — recovery was not changed.".into())
            }
            other => CommandError::Api(other.to_string()),
        })?;
    Ok(RegisterResult {
        user_id: me.id,
        recovery_phrase: phrase,
    })
}

#[tauri::command]
pub async fn auth_recovery(
    email: String,
    phrase: String,
    new_password: String,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let start = api
        .recovery_start(&email)
        .await
        .map_err(describe_recovery_error)?;
    let recovery_bytes = B64
        .decode(start.recovery_blob_b64.as_bytes())
        .map_err(|_| CommandError::Recovery("recovery blob".into()))?;
    let master_key = bip39_recovery::unwrap_master_key(&recovery_bytes, &phrase)?;
    let recovery_auth_key = kdf::derive_recovery_auth_key(&phrase)?;
    let new_salt = kdf::random_salt();
    let new_auth = kdf::derive_auth_key(new_password.as_bytes(), &new_salt)?;
    let new_master = kdf::derive_master_key(new_password.as_bytes(), &new_salt)?;
    let new_recovery = bip39_recovery::wrap_master_key(&master_key, &phrase)?;
    // The phrase is unchanged, so the stored hash must stay as it is: rotating it here
    // to a key derived from the same phrase would be a no-op at best.
    let resp = api
        .recovery_finish(
            &email,
            &recovery_auth_key.0,
            &new_salt,
            &new_auth.0,
            &new_recovery,
            None,
        )
        .await
        .map_err(describe_recovery_error)?;
    let uid = resp
        .user_id
        .ok_or_else(|| CommandError::Api("recovery response missing user_id".into()))?;
    keychain::store_master_key(&uid, &master_key).map_err(|e| CommandError::Keychain(e.to_string()))?;
    let _ = new_master;
    Ok(uid)
}
