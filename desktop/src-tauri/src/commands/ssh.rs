use std::path::PathBuf;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::auth::CommandError;
use crate::ssh::client::{connect, append_known_host, ConnectOptions, SshError, SshSession};

#[derive(Clone, Serialize)]
pub struct HostKeyPrompt {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
}

pub fn known_hosts_path(app: &AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(dir.join("ssh").join("known_hosts"))
}

#[tauri::command]
pub fn ssh_accept_host_key(
    app: AppHandle,
    host: String,
    port: u16,
    fingerprint: String,
) -> Result<(), CommandError> {
    let path = known_hosts_path(&app)?;
    append_known_host(&path, &format!("{host}:{port}"), &fingerprint)
        .map_err(|e| CommandError::Api(e.to_string()))
}

#[tauri::command]
pub async fn ssh_exec(
    app: AppHandle,
    host: String,
    port: u16,
    user: String,
    password: String,
    command: String,
) -> Result<(i32, String), CommandError> {
    let path = known_hosts_path(&app)?;
    let opts = ConnectOptions {
        host: &host,
        port,
        user: &user,
        password: password.as_bytes(),
        known_hosts_path: path,
        timeout: Duration::from_secs(45),
    };
    let mut session = match connect(opts).await {
        Err(SshError::HostKeyUnknown { fingerprint }) => {
            let _ = app.emit(
                "ssh:host-key-prompt",
                HostKeyPrompt {
                    host: host.clone(),
                    port,
                    fingerprint,
                },
            );
            return Err(CommandError::Api("HOST_KEY_UNKNOWN".into()));
        }
        Err(e) => return Err(CommandError::Api(e.to_string())),
        Ok(s) => s,
    };
    let out = session
        .exec(&command, Duration::from_secs(300), false)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let _ = session.disconnect().await;
    Ok(out)
}

/// Used by provisioning; same host-key / TOFU semantics as [`ssh_exec`].
pub async fn ssh_connect_session(
    app: &AppHandle,
    host: &str,
    port: u16,
    user: &str,
    password: &[u8],
) -> Result<SshSession, CommandError> {
    let path = known_hosts_path(app)?;
    let opts = ConnectOptions {
        host,
        port,
        user,
        password,
        known_hosts_path: path,
        timeout: Duration::from_secs(45),
    };
    match connect(opts).await {
        Err(SshError::HostKeyUnknown { fingerprint }) => {
            let _ = app.emit(
                "ssh:host-key-prompt",
                HostKeyPrompt {
                    host: host.to_string(),
                    port,
                    fingerprint,
                },
            );
            Err(CommandError::Api("HOST_KEY_UNKNOWN".into()))
        }
        Err(e) => Err(CommandError::Api(e.to_string())),
        Ok(s) => Ok(s),
    }
}
