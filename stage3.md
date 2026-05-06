# Stage 3 — Desktop SSH + Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop performs every operation the deleted backend did — SSH to FastPanel, Cloudflare API, registrar APIs, full domain provision pipeline — but locally with secrets decrypted in-memory. Adds strict host-key checking with TOFU prompt, idempotency keys for bulk actions, and audit log entries pushed to server (no plaintext).

**Architecture:** Each integration is a Rust module mirroring the Python service it replaces. Functions take a decrypted secret (loaded via `vault_decrypt_blob`), perform the work, zeroize on drop. SSH via `russh`. HTTP via `reqwest`. XML (Namecheap) via `quick-xml`. Bulk operations track idempotency in local SQLite to prevent double-execution from double-clicks.

**Tech Stack:** `russh`, `russh-keys`, `reqwest`, `quick-xml`, `regex`, `shell-escape`. Test infrastructure: `linuxserver/openssh-server` Docker image as SSH target, `wiremock` for HTTP mocks.

---

## Task 1: SSH client with strict host-key checking

**Files:**
- Create: `desktop/src-tauri/src/ssh/client.rs`
- Reference for porting: deleted `backend/app/services/fastpanel_client.py:14-53` (open_ssh, run_remote)

- [ ] **Step 1: Implement `SshSession` wrapper around `russh`**

```rust
// desktop/src-tauri/src/ssh/client.rs
use russh::*;
use russh_keys::*;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::time::Duration;
use zeroize::Zeroize;

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("connect: {0}")] Connect(String),
    #[error("auth failed")] Auth,
    #[error("host key mismatch")] HostKeyMismatch,
    #[error("host key unknown - approval required: {fingerprint}")]
    HostKeyUnknown { fingerprint: String },
    #[error("io: {0}")] Io(#[from] std::io::Error),
    #[error("session: {0}")] Session(String),
}

pub struct SshSession {
    handle: client::Handle<HostKeyChecker>,
}

#[derive(Clone)]
struct HostKeyChecker {
    known_hosts_path: PathBuf,
    expected_host: String,
}

#[async_trait::async_trait]
impl client::Handler for HostKeyChecker {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKey) -> Result<bool, Self::Error> {
        // Read known_hosts file. If entry for self.expected_host exists:
        //   - matches: accept
        //   - differs: reject (HostKeyMismatch)
        // If no entry: reject and let caller present TOFU prompt to user via Tauri event.
        let fingerprint = server_public_key.fingerprint();
        match read_known_host(&self.known_hosts_path, &self.expected_host)? {
            Some(known) if known == fingerprint => Ok(true),
            Some(_) => {
                tracing::error!("host key mismatch for {}", self.expected_host);
                Ok(false)
            }
            None => Ok(false), // Caller surfaces TOFU prompt
        }
    }
}

fn read_known_host(_path: &PathBuf, _host: &str) -> Result<Option<String>, std::io::Error> {
    // Read the known_hosts file format: each line "host fingerprint"
    // Return matching fingerprint or None.
    todo!("implement file read; see implementation in task 1 step 2")
}

pub struct ConnectOptions<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: &'a [u8], // zeroized on drop by caller
    pub known_hosts_path: PathBuf,
    pub timeout: Duration,
}

pub async fn connect(opts: ConnectOptions<'_>) -> Result<SshSession, SshError> {
    let config = client::Config { inactivity_timeout: Some(opts.timeout), ..Default::default() };
    let checker = HostKeyChecker {
        known_hosts_path: opts.known_hosts_path,
        expected_host: format!("{}:{}", opts.host, opts.port),
    };
    let mut handle = client::connect(Arc::new(config), (opts.host, opts.port), checker)
        .await
        .map_err(|e| SshError::Connect(e.to_string()))?;
    // Map password (bytes) to UTF-8 owned string for russh API; zeroize copy after auth.
    let mut pwd = String::from_utf8_lossy(opts.password).into_owned();
    let auth_ok = handle.authenticate_password(opts.user, &pwd)
        .await
        .map_err(|e| SshError::Session(e.to_string()))?;
    pwd.zeroize();
    if !auth_ok {
        return Err(SshError::Auth);
    }
    Ok(SshSession { handle })
}

impl SshSession {
    pub async fn exec(&mut self, cmd: &str, timeout: Duration) -> Result<(i32, String), SshError> {
        let mut channel = self.handle.channel_open_session().await
            .map_err(|e| SshError::Session(e.to_string()))?;
        channel.request_pty(true, "xterm", 80, 24, 0, 0, &[]).await
            .map_err(|e| SshError::Session(e.to_string()))?;
        channel.exec(true, cmd).await.map_err(|e| SshError::Session(e.to_string()))?;
        let mut output = Vec::new();
        let mut exit: i32 = -1;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(channel::ChannelMsg::Data { ref data }) => output.extend_from_slice(data),
                        Some(channel::ChannelMsg::ExitStatus { exit_status }) => exit = exit_status as i32,
                        Some(channel::ChannelMsg::Close) | Some(channel::ChannelMsg::Eof) => break,
                        Some(_) => {}
                        None => break,
                    }
                }
                _ = tokio::time::sleep_until(deadline) => return Err(SshError::Session("exec timeout".into())),
            }
        }
        Ok((exit, String::from_utf8_lossy(&output).to_string()))
    }
}
```

- [ ] **Step 2: Implement `read_known_host` and `append_known_host`**

Format: `<host:port> <fingerprint>\n` — one entry per line, lock with file lock when writing. Tauri command `ssh_accept_host_key` appends.

- [ ] **Step 3: Tauri events for TOFU prompt**

When `connect` returns `HostKeyUnknown`, the calling Tauri command emits an `ssh:host-key-prompt` event with `{ host, port, fingerprint }`. The React UI shows a modal; on accept, calls `ssh_accept_host_key` which appends to known_hosts; the user retries the action.

- [ ] **Step 4: Integration test against `linuxserver/openssh-server`**

`desktop/src-tauri/tests/ssh_integration.rs` (gated `#[cfg_attr(not(feature = "ssh_integration"), ignore)]`):

```bash
docker run -d --name sdmp-test-ssh \
  -e PASSWORD_ACCESS=true -e USER_NAME=test -e USER_PASSWORD=testpass \
  -p 2222:2222 lscr.io/linuxserver/openssh-server:latest
```

Test cases:
- First connect with empty `known_hosts` → returns `HostKeyUnknown` with fingerprint.
- After append, second connect succeeds.
- Run `uname -a`, expect `Linux` in output.
- Tamper `known_hosts` to wrong fingerprint → `HostKeyMismatch`.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/ssh/client.rs desktop/src-tauri/tests/ssh_integration.rs
git commit -m "feat(ssh): russh client with strict host-key checking and TOFU"
```

---

## Task 2: Port FastPanel logic to Rust

**Source to mirror:** deleted `backend/app/services/fastpanel_client.py` (all functions). Refer to git history if needed: `git log --all -- backend/app/services/fastpanel_client.py`.

**Files:**
- Create: `desktop/src-tauri/src/ssh/fastpanel.rs`

Functions to port (signatures in Rust):

| Python                   | Rust                                                                                                              | Source lines      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- | ----------------- |
| `get_fastpanel_path`     | `get_fastpanel_path(s: &mut SshSession, override: Option<&str>) -> Result<Option<String>, SshError>`              | 56-65             |
| `make_site_user`         | `make_site_user(domain: &str) -> String`                                                                          | 68-70             |
| `make_ftp_login`         | `make_ftp_login(domain: &str) -> String`                                                                          | 73-75             |
| `generate_password`      | `generate_password(len: usize) -> String` (use `dryoc::rng::randombytes_buf` over alphabet)                       | 78-80             |
| `site_exists`            | `site_exists(s, site_user, domain) -> Result<bool, SshError>`                                                     | 83-86             |
| `cert_exists`            | `cert_exists(s, domain) -> Result<bool, SshError>`                                                                | 89-92             |
| `create_site`            | `create_site(s, fp_path, domain, php_version) -> Result<CreateSiteResult, SshError>`                              | 95-117            |
| `create_ftp_account`     | `create_ftp_account(s, fp_path, domain) -> Result<CreateFtpResult, SshError>`                                     | 120-…             |
| `create_database`        | `create_database(s, fp_path, domain, db_name, db_user) -> Result<CreateDbResult, SshError>`                       | ~167-214          |
| `revoke_ssl_certificate` | `revoke_ssl(s, fp_path, domain) -> Result<RevokeResult, SshError>`                                                | 217-236           |
| `read_ssl_info_via_ssh`  | `read_ssl_info(s, domain) -> Result<SslInfo, SshError>`                                                           | 239-277           |
| `apply_nginx_override`   | `apply_nginx_override(s, fp_path, domain, site_user, snippet, presets) -> Result<ApplyResult, SshError>`          | 308-346           |
| `ensure_ports_open`      | `ensure_ports_open(s, ports) -> Result<PortsResult, SshError>`                                                    | 357-379           |
| `dns_resolves_to`        | `dns_resolves_to(domain, expected_ip, attempts, delay) -> Result<bool, SshError>` (use `tokio::net::lookup_host`) | 382-396           |
| `list_sites`             | `list_sites(s, fp_path) -> Result<Vec<SiteInfo>, SshError>`                                                       | 529-…             |
| `issue_ssl_certificate`  | `issue_ssl(s, fp_path, domain, email) -> Result<IssueSslResult, SshError>`                                        | (in deleted file) |

- [ ] **Step 1: Define result structs**

```rust
// desktop/src-tauri/src/ssh/fastpanel.rs
use serde::Serialize;

#[derive(Serialize)]
pub struct CreateSiteResult {
    pub site_user: String,
    pub site_path: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct CreateFtpResult {
    pub ftp_user: String,
    pub ftp_password: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct CreateDbResult {
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct SslInfo {
    pub has_certificate: bool,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub issuer: Option<String>,
    pub is_letsencrypt: bool,
}

#[derive(Serialize)]
pub struct SiteInfo {
    pub domain_name: String,
    pub site_user: Option<String>,
    pub site_path: Option<String>,
    pub php_version: Option<String>,
}
```

- [ ] **Step 2: Port each function**

Port mechanically. For shell escaping, use the `shell-escape` crate. For regex parsing of `openssl x509` output, use `regex`. The Python source is the authoritative spec. Each function gets a unit test that mocks the SSH session via a trait and verifies command construction (no live SSH needed for command-construction tests; live tests in Task 3).

Skeleton example for `create_site`:

```rust
use shell_escape::escape;
use std::borrow::Cow;
use std::time::Duration;

pub async fn create_site(
    s: &mut crate::ssh::client::SshSession,
    fp_path: &str,
    domain: &str,
    php_version: &str,
) -> Result<CreateSiteResult, crate::ssh::client::SshError> {
    let site_user = make_site_user(domain);
    let cmd = format!(
        "{} sites create --server-name={} --owner={} --create-user --php-version={}",
        escape(Cow::Borrowed(fp_path)),
        escape(Cow::Borrowed(domain)),
        escape(Cow::Borrowed(&site_user)),
        escape(Cow::Borrowed(php_version)),
    );
    let (code, output) = s.exec(&cmd, Duration::from_secs(120)).await?;
    if code != 0 {
        return Err(crate::ssh::client::SshError::Session(format!("create_site exit {}: {}", code, output)));
    }
    if !site_exists(s, &site_user, domain).await? {
        return Err(crate::ssh::client::SshError::Session("site directory check failed".into()));
    }
    Ok(CreateSiteResult {
        site_user: site_user.clone(),
        site_path: format!("/var/www/{}/data/www/{}", site_user, domain),
        output,
    })
}
```

- [ ] **Step 3: Add `chrono` to Cargo.toml**

```toml
chrono = { version = "0.4", features = ["serde"] }
regex = "1"
```

- [ ] **Step 4: Unit tests for command construction**

For each function, assert the constructed shell command string matches expected:

```rust
#[test]
fn create_site_builds_quoted_command() {
    // Use a mock SshSession capturing the cmd; or pull command construction into a pure helper.
    let cmd = build_create_site_cmd("/usr/local/fastpanel2/fastpanel", "example.com", "ex_usr", "8.1");
    assert_eq!(cmd, "/usr/local/fastpanel2/fastpanel sites create --server-name=example.com --owner=ex_usr --create-user --php-version=8.1");
}
```

(Refactor each port to extract a `build_*_cmd` pure function so tests don't need SSH.)

- [ ] **Step 5: Commit per function**

```bash
git add desktop/src-tauri/src/ssh/fastpanel.rs
git commit -m "feat(ssh/fastpanel): port get_fastpanel_path/create_site/create_ftp/create_db"
# repeat for each batch
```

---

## Task 3: Cloudflare API client port

**Source to mirror:** deleted `backend/app/services/cloudflare_service.py`.

**Files:**
- Create: `desktop/src-tauri/src/cloudflare/client.rs`

Functions (mirror Python signatures):

| Python                                       | Rust                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `_call(account, method, path, params, json)` | `pub async fn call(token: &str, method: Method, path: &str, ...) -> Result<serde_json::Value, CloudflareError>` |
| `verify_token`                               | `pub async fn verify_token(token: &str) -> Result<bool, CloudflareError>`                                       |
| `list_zones`                                 | `pub async fn list_zones(token: &str) -> Result<Vec<Zone>, CloudflareError>`                                    |
| `get_zone`                                   | `pub async fn get_zone(token: &str, zone_id: &str) -> Result<Zone, CloudflareError>`                            |
| `list_dns_records`                           | `pub async fn list_dns_records(token: &str, zone_id: &str) -> Result<Vec<DnsRecord>, CloudflareError>`          |
| `create_dns_record`                          | `pub async fn create_dns_record(token, zone_id, payload) -> Result<DnsRecord, CloudflareError>`                 |
| `update_dns_record`                          | `pub async fn update_dns_record(...)`                                                                           |
| `delete_dns_record`                          | `pub async fn delete_dns_record(...)`                                                                           |
| `purge_cache`                                | `pub async fn purge(...)`                                                                                       |
| `create_zone`                                | `pub async fn create_zone(...)`                                                                                 |
| `get_nameservers`                            | `pub async fn get_nameservers(token, zone_id) -> Result<Vec<String>, CloudflareError>`                          |

- [ ] **Step 1: Implement using `reqwest` + JSON**

Use `reqwest::Client` with `Authorization: Bearer <token>` header. Token is passed as `&str` and zeroized in caller.

- [ ] **Step 2: Test with `wiremock`**

For each method, set up a mock that returns Cloudflare-shaped JSON, assert client parses correctly, assert request has correct path/method/headers.

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/cloudflare/
git commit -m "feat(cloudflare): port verify/list_zones/dns CRUD/purge/create_zone to Rust"
```

---

## Task 4: Registrar clients port

**Source to mirror:** deleted `backend/app/services/registrars/{base,factory,hostiq,namecheap}.py`.

**Files:**
- Create: `desktop/src-tauri/src/registrars/mod.rs` (factory + trait)
- Create: `desktop/src-tauri/src/registrars/hostiq.rs`
- Create: `desktop/src-tauri/src/registrars/namecheap.rs`

- [ ] **Step 1: Trait definition**

```rust
// desktop/src-tauri/src/registrars/mod.rs
use async_trait::async_trait;

#[derive(Debug, thiserror::Error)]
pub enum RegistrarError {
    #[error("api: {0}")] Api(String),
    #[error("not implemented")] NotImplemented,
}

#[async_trait]
pub trait RegistrarService: Send + Sync {
    async fn test_connection(&self) -> Result<(bool, String), RegistrarError>;
    async fn get_domains(&self) -> Result<Vec<DomainInfo>, RegistrarError>;
    async fn set_nameservers(&self, domain: &str, ns: &[String]) -> Result<bool, RegistrarError>;
    async fn get_nameservers(&self, domain: &str) -> Result<Vec<String>, RegistrarError>;
}

pub struct DomainInfo {
    pub domain: String,
    pub expiry_date: Option<String>,
    pub status: Option<String>,
    pub nameservers: Vec<String>,
}

pub fn make_service(provider: &str, api_key: &str, api_user: Option<&str>, api_secret: Option<&str>) -> Result<Box<dyn RegistrarService>, RegistrarError> {
    match provider.to_lowercase().as_str() {
        "hostiq" => Ok(Box::new(hostiq::HostiqService::new(api_key))),
        "namecheap" => Ok(Box::new(namecheap::NamecheapService::new(api_key, api_user.unwrap_or(""), api_secret.unwrap_or("127.0.0.1")))),
        other => Err(RegistrarError::Api(format!("unknown provider: {}", other))),
    }
}

pub mod hostiq;
pub mod namecheap;
```

- [ ] **Step 2: Hostiq impl**

JSON API. Mirror Python in `backend/app/services/registrars/hostiq.py`. Use `reqwest`.

- [ ] **Step 3: Namecheap impl**

XML API. Mirror Python in `backend/app/services/registrars/namecheap.py`. Use `quick-xml`.

- [ ] **Step 4: Tests with wiremock**

Hostiq: mock `/domains` JSON; assert parse. Set NS: mock `/domains/<d>/nameservers` PUT; assert payload.

Namecheap: mock the single XML endpoint with parameterized responses for `domains.getList` and `domains.dns.setCustom`. Assert parsed shape and that `setCustom` URL contains `Command=namecheap.domains.dns.setCustom` and `Nameservers=ns1.x,ns2.x`.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/registrars/
git commit -m "feat(registrars): port hostiq + namecheap clients"
```

---

## Task 5: Provision pipeline port

**Source to mirror:** deleted `backend/app/tasks/provision_task.py`, `bulk_full_setup_task.py`, `fastpanel_task.py`.

**Files:**
- Create: `desktop/src-tauri/src/provision/domain.rs`
- Create: `desktop/src-tauri/src/provision/fastpanel_install.rs`
- Create: `desktop/src-tauri/src/provision/bulk.rs`

The pipeline pattern (mirror of `provision_task._main`):

1. Load domain metadata (from local cache).
2. Load SSH credentials (decrypt blob via vault).
3. Connect SSH (host-key check).
4. Get `fastpanel` path.
5. `ensure_ports_open(80, 443)` — log warning if firewall preflight fails.
6. If site doesn't exist → `create_site`. Persist `site_user`, `site_path`, `php_version` back to cache + sync push.
7. If `!site_only`: `create_ftp_account`, store `ftp_user` + `ftp_password` (the password becomes a NEW BLOB encrypted client-side and pushed to server).
8. SSL phase:
   a. `dns_resolves_to(domain, server_ip)` — fail → status `ssl_error`, abort SSL step.
   b. Pick SSL email from local pool (per-user blob containing `[{email, usage_count, usage_cap}]`).
   c. `issue_ssl(domain, email)` — on success, mark email used, set `ssl_status=active`.
9. Push audit log entry: `device.action.complete` with metadata `{domain, server, steps_done}` (no plaintext).
10. Update domain status in cache + sync push.

- [ ] **Step 1: Implement `provision_domain` async fn**

Take `&domain_id`, load from cache, run the steps. Return a `ProvisionResult` event stream via `tokio::sync::mpsc::Sender<ProvisionEvent>` so the UI gets real-time progress.

- [ ] **Step 2: Idempotency for bulk**

`bulk.rs` accepts a `Vec<domain_id>`, generates an `idempotency_key = sha256(action || sorted(domain_ids) || started_at)`, persists in `local_cache.bulk_runs` with status. If user double-clicks, the second invocation finds the existing run and returns its in-progress state instead of re-executing.

- [ ] **Step 3: FastPanel install pipeline**

Mirror `fastpanel_task._install`. Steps: connect SSH → run system update → run install script (`wget … | bash -`) → parse credentials regex → store as new blobs (`fastpanel_password_blob_id`) → set status `installed`. **Add idempotency:** refuse to run if cache shows `fastpanel_status == "installed"`; require explicit `force` flag.

- [ ] **Step 4: Tauri commands**

```rust
#[tauri::command]
pub async fn provision_domain(domain_id: String, app_handle: tauri::AppHandle, ...) -> Result<(), CommandError> { ... }

#[tauri::command]
pub async fn provision_bulk(domain_ids: Vec<String>, ...) -> Result<String, CommandError> { ... } // returns run_id

#[tauri::command]
pub async fn install_fastpanel(server_id: String, force: bool, ...) -> Result<(), CommandError> { ... }
```

Each command emits Tauri events `provision:progress`, `install:progress` for UI.

- [ ] **Step 5: Tests**

Integration test using `linuxserver/openssh-server` Docker container with FastPanel-stub script (a fake `/usr/local/bin/fastpanel` script returning canned output) — verify the pipeline reaches `success` state.

- [ ] **Step 6: Commit**

```bash
git add desktop/src-tauri/src/provision/
git commit -m "feat(provision): port domain provision + bulk + fastpanel install pipelines"
```

---

## Task 6: Wire execute UI in frontend (desktop only)

**Files:**
- Modify: `frontend/src/components/BulkActionToolbar.tsx`
- Modify: `frontend/src/components/BulkSetupWizard.tsx`
- Modify: `frontend/src/components/TaskProgressModal.tsx`
- Modify: `frontend/src/components/MultiTaskProgressModal.tsx`
- Modify: `frontend/src/pages/Domains.tsx`, `Servers.tsx`, `ServerDetail.tsx`, `Cloudflare.tsx`

- [ ] **Step 1: Replace REST calls with `invokeIfTauri`**

For each existing button that POSTed to a deleted endpoint:

```typescript
// before
await apiPost('/domains/{id}/provision', ...);
// after
await invokeIfTauri('provision_domain', { domainId });
```

Listen for events with `listen('provision:progress', ...)` from `@tauri-apps/api/event`.

- [ ] **Step 2: Gate by `isTauri()`**

Buttons render disabled with a tooltip "Open in desktop app to use this action" on web.

- [ ] **Step 3: TOFU modal**

Listen for `ssh:host-key-prompt`. Show modal with fingerprint + `Accept` / `Reject` buttons. On accept, call `invokeIfTauri('ssh_accept_host_key', { host, port, fingerprint })`.

- [ ] **Step 4: Test with vitest + jsdom**

For each component, snapshot the disabled-on-web variant and the active-on-desktop variant.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/
git commit -m "feat(frontend): wire bulk/provision UI to Tauri commands; web shows disabled CTA"
```

---

## Task 7: Audit log push

For every successful `device.action.complete` and `device.action.fail`, the desktop sends a `POST /api/audit/log` request to the server. Body excludes any plaintext.

**Files:**
- Modify: `desktop/src-tauri/src/sync/http.rs` (add `audit_log` method)
- Modify: each provision module to call `api.audit_log(...)` at completion/failure

- [ ] **Step 1: Add method**

```rust
pub async fn audit_log(&self, action: &str, target_type: &str, target_id: &str, metadata: serde_json::Value) -> Result<(), ApiError> {
    let resp = self.http.post(format!("{}/audit/log", self.base_url))
        .json(&serde_json::json!({
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "metadata": metadata,
        }))
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(ApiError::Status { status: resp.status().as_u16(), body: resp.text().await? });
    }
    Ok(())
}
```

- [ ] **Step 2: Plaintext guard**

Lint test: every metadata struct used with `audit_log` must derive a `RedactCheck` trait that asserts no field name contains "password", "token", "key", "secret".

```rust
#[macro_export]
macro_rules! redact_check {
    ($v:expr) => {{
        let s = serde_json::to_string(&$v).unwrap();
        debug_assert!(!s.to_lowercase().contains("password"), "audit metadata contains 'password'");
        debug_assert!(!s.to_lowercase().contains("\"token\""), "audit metadata contains 'token'");
    }};
}
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/
git commit -m "feat(audit): push device-action audit entries to server with plaintext guards"
```

---

## Stage 3 verification

```bash
# Cargo
cd desktop/src-tauri && cargo test --features ssh_integration
# Expected: all unit tests + integration tests with linuxserver/openssh-server pass

# Manual end-to-end on a real Hetzner test VPS:
# 1. Create test VPS at hetzner.cloud (CX22 ~5€/mo)
# 2. In desktop app, add server with SSH password (root@<ip>)
# 3. test SSH from app — accept host-key fingerprint prompt
# 4. install FastPanel (~15 min wait)
# 5. add domain, link to server, link to Cloudflare account, link to registrar
# 6. provision domain — site + FTP + DB + SSL all complete
# 7. open web app, verify domain appears with status "active"
# 8. grep server logs and audit_log table — no plaintext SSH password, no FTP password, no API token

cd ../../backend
psql $SUPABASE_DB_URL -c "select metadata from audit_log where user_id = '<your_user_id>' order by ts desc limit 20;"
# Expected: action names like "device.action.complete", no password fields in metadata
```

Stage 3 is complete when:
- Cargo unit + integration tests pass.
- Manual end-to-end provision against a real VPS succeeds.
- `audit_log.metadata` contains no plaintext secrets in any row.
- Bulk action double-click test does NOT double-execute (verify by checking server-side audit count).
- Host-key change on a server triggers a hard error in the desktop UI (test by re-installing the test VPS).

Move to [Stage 4](./2026-05-06-stage-4-web-readonly-refactor.md).
