//! SSH client (russh) with strict host-key checking and TOFU support.

use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use fs2::FileExt;
use russh::client::{self, Handler};
use russh::keys::key;
use russh::ChannelMsg;
use tokio::time::Duration;
use zeroize::Zeroize;

/// Errors surfaced to callers (Tauri, provisioning).
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("connect: {0}")]
    Connect(String),
    #[error("auth failed")]
    Auth,
    #[error("host key mismatch")]
    HostKeyMismatch,
    #[error("host key unknown — approve fingerprint in UI: {fingerprint}")]
    HostKeyUnknown { fingerprint: String },
    #[error("io: {0}")]
    Io(#[from] io::Error),
    #[error("session: {0}")]
    Session(String),
}

#[derive(Debug, thiserror::Error)]
pub enum SshConnectHandlerError {
    #[error(transparent)]
    Russh(#[from] russh::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("host key mismatch")]
    HostKeyMismatch,
}

pub struct ClientHandler {
    pub known_hosts_path: PathBuf,
    pub expected_host: String,
    pub pending_unknown_fp: Arc<Mutex<Option<String>>>,
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = SshConnectHandlerError;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint();
        match read_known_host(&self.known_hosts_path, &self.expected_host)? {
            Some(known) if known == fp => Ok(true),
            Some(_) => Err(SshConnectHandlerError::HostKeyMismatch),
            None => {
                *self.pending_unknown_fp.lock().expect("lock") = Some(fp);
                Ok(false)
            }
        }
    }
}

/// One line per entry: `host:port base64_fingerprint`
pub fn read_known_host(path: &Path, host_port: &str) -> io::Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(path)?;
    for raw in data.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        let host = it.next().unwrap_or("");
        let fp = it.next();
        if host == host_port {
            return Ok(fp.map(|s| s.to_string()));
        }
    }
    Ok(None)
}

pub fn append_known_host(path: &Path, host_port: &str, fingerprint: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.lock_exclusive()?;
    writeln!(f, "{} {}", host_port, fingerprint)?;
    f.unlock()?;
    Ok(())
}

pub struct ConnectOptions<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: &'a [u8],
    pub known_hosts_path: PathBuf,
    pub timeout: Duration,
}

pub struct SshSession {
    pub(crate) handle: client::Handle<ClientHandler>,
}

pub async fn connect(opts: ConnectOptions<'_>) -> Result<SshSession, SshError> {
    let pending = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        known_hosts_path: opts.known_hosts_path.clone(),
        expected_host: format!("{}:{}", opts.host, opts.port),
        pending_unknown_fp: pending.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(opts.timeout),
        ..Default::default()
    });

    let mut handle = match client::connect(config, (opts.host, opts.port), handler).await {
        Ok(h) => h,
        Err(SshConnectHandlerError::HostKeyMismatch) => return Err(SshError::HostKeyMismatch),
        Err(SshConnectHandlerError::Io(e)) => return Err(SshError::Io(e)),
        Err(SshConnectHandlerError::Russh(e)) => {
            if matches!(e, russh::Error::UnknownKey) {
                let fp = pending.lock().expect("lock").take();
                return if let Some(fingerprint) = fp {
                    Err(SshError::HostKeyUnknown { fingerprint })
                } else {
                    Err(SshError::Connect(e.to_string()))
                };
            }
            return Err(SshError::Connect(e.to_string()));
        }
    };

    let mut pwd = String::from_utf8_lossy(opts.password).into_owned();
    let auth_ok = handle
        .authenticate_password(opts.user, pwd.clone())
        .await
        .map_err(|e| SshError::Session(e.to_string()))?;
    pwd.zeroize();
    if !auth_ok {
        return Err(SshError::Auth);
    }
    Ok(SshSession { handle })
}

impl SshSession {
    /// Run a remote command. Use `pty = false` for non-interactive CLIs (FastPanel list, etc.).
    pub async fn exec(
        &mut self,
        cmd: &str,
        timeout: Duration,
        pty: bool,
    ) -> Result<(i32, String), SshError> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Session(e.to_string()))?;
        if pty {
            channel
                .request_pty(true, "xterm", 80, 24, 0, 0, &[])
                .await
                .map_err(|e| SshError::Session(e.to_string()))?;
        }
        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| SshError::Session(e.to_string()))?;

        let mut output = Vec::new();
        let mut exit: i32 = -1;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => output.extend_from_slice(data.as_ref()),
                        Some(ChannelMsg::ExtendedData { data, .. }) => output.extend_from_slice(data.as_ref()),
                        Some(ChannelMsg::ExitStatus { exit_status }) => exit = exit_status as i32,
                        Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) => break,
                        Some(_) => {}
                        None => break,
                    }
                }
                _ = tokio::time::sleep_until(deadline) => return Err(SshError::Session("exec timeout".into())),
            }
        }
        Ok((exit, String::from_utf8_lossy(&output).into_owned()))
    }

    pub async fn disconnect(&mut self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .map_err(|e| SshError::Session(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_append_known_host_roundtrip() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("kh");
        let hp = "10.0.0.1:22";
        assert_eq!(read_known_host(&p, hp).unwrap(), None);
        append_known_host(&p, hp, "abc123").unwrap();
        assert_eq!(
            read_known_host(&p, hp).unwrap().as_deref(),
            Some("abc123")
        );
        append_known_host(&p, "h:2222", "xyz").unwrap();
        assert_eq!(read_known_host(&p, hp).unwrap().as_deref(), Some("abc123"));
        assert_eq!(read_known_host(&p, "h:2222").unwrap().as_deref(), Some("xyz"));
    }
}
