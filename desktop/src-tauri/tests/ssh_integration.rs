//! Integration tests against a local SSH server (e.g. linuxserver/openssh-server on port 2222).
//!
//! ```bash
//! docker run -d --name sdmp-test-ssh \
//!   -e PASSWORD_ACCESS=true -e USER_NAME=test -e USER_PASSWORD=testpass \
//!   -p 2222:2222 lscr.io/linuxserver/openssh-server:latest
//! ```
//!
//! Run: `cargo test -p sdmp-desktop --features ssh_integration --test ssh_integration -- --ignored --nocapture`

use std::path::PathBuf;
use std::time::Duration;

use sdmp_desktop_lib::ssh::client::{append_known_host, connect, read_known_host, ConnectOptions, SshError};

fn ssh_addr() -> (&'static str, u16) {
    let host = std::env::var("SDMP_SSH_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("SDMP_SSH_TEST_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2222);
    // linuxserver image uses host string in tests — leak Box::leak for static ref simplicity
    let host: &'static str = Box::leak(host.into_boxed_str());
    (host, port)
}

#[tokio::test]
#[ignore = "requires docker ssh on SDMP_SSH_TEST_HOST:SDMP_SSH_TEST_PORT"]
async fn tofu_then_exec_uname() {
    let (host, port) = ssh_addr();
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");

    let opts = ConnectOptions {
        host,
        port,
        user: "test",
        password: b"testpass",
        known_hosts_path: kh.clone(),
        timeout: Duration::from_secs(20),
    };

    let fp = match connect(opts).await {
        Err(SshError::HostKeyUnknown { fingerprint }) => fingerprint,
        Ok(_) => panic!("expected unknown host on empty known_hosts"),
        Err(e) => panic!("unexpected error: {e}"),
    };

    append_known_host(&kh, &format!("{host}:{port}"), &fp).unwrap();
    assert!(read_known_host(&kh, &format!("{host}:{port}"))
        .unwrap()
        .is_some());

    let opts2 = ConnectOptions {
        host,
        port,
        user: "test",
        password: b"testpass",
        known_hosts_path: kh.clone(),
        timeout: Duration::from_secs(20),
    };
    let mut sess = connect(opts2).await.expect("second connect");
    let (code, out) = sess
        .exec("uname -a", Duration::from_secs(30), false)
        .await
        .expect("exec");
    assert_eq!(code, 0);
    assert!(out.to_lowercase().contains("linux"), "{}", out);
    let _ = sess.disconnect().await;
}

#[tokio::test]
#[ignore = "requires docker ssh"]
async fn host_key_mismatch() {
    let (host, port) = ssh_addr();
    let tmp = tempfile::tempdir().unwrap();
    let kh: PathBuf = tmp.path().join("known_hosts");
    append_known_host(&kh, &format!("{host}:{port}"), "bogusfingerprintnotreal")
        .unwrap();

    let opts = ConnectOptions {
        host,
        port,
        user: "test",
        password: b"testpass",
        known_hosts_path: kh,
        timeout: Duration::from_secs(20),
    };
    let r = connect(opts).await;
    assert!(matches!(r, Err(SshError::HostKeyMismatch)));
}
