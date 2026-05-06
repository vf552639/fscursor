# Stage 2 — Tauri Shell + Crypto + Sync Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop app boots, user can register, log in, see metadata-only views synced from server. Master key derived client-side, kept in OS keychain. Encrypted local SQLite cache. No SSH execution yet — Stage 3 adds that.

**Architecture:** Rust core under `desktop/src-tauri/src/` exposes Tauri commands (`auth_register`, `auth_login`, `vault_*`, `sync_*`) callable from React via `@tauri-apps/api/core::invoke`. Crypto is `dryoc` (libsodium) — Argon2id KDF (`t=3 m=64MiB p=4`) and XChaCha20-Poly1305 AEAD. Master key stored in OS keychain (`keyring` crate), never written to disk. Local cache in SQLite via `rusqlite` with `bundled-sqlcipher`, opened with a sub-key derived from the master key. Sync client polls server every 60s.

**Tech Stack:** Rust, Tauri 2, `dryoc`, `keyring`, `rusqlite` + `bundled-sqlcipher`, `tiny-bip39`, `zeroize`, `tokio`, `reqwest`, `serde`. Frontend: React + TypeScript (existing), `@tauri-apps/api`, zustand for auth state.

---

## Task 1: Crypto KDF — Argon2id wrapper

**Files:**
- Create: `desktop/src-tauri/src/crypto/kdf.rs`
- Test: same file (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

```rust
// desktop/src-tauri/src/crypto/kdf.rs
use dryoc::pwhash::{PwHash, Salt, VecPwHash};
use zeroize::Zeroize;

/// Per-context labels keep auth and encryption keys derivationally distinct.
const CONTEXT_AUTH: &[u8] = b"sdmp-auth-key-v1";
const CONTEXT_ENC: &[u8] = b"sdmp-master-key-v1";

const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;

#[derive(Debug, thiserror::Error)]
pub enum KdfError {
    #[error("kdf failed: {0}")]
    Hash(String),
    #[error("invalid salt length: {0}")]
    Salt(usize),
}

#[derive(Zeroize)]
#[zeroize(drop)]
pub struct DerivedKey(pub [u8; KEY_LEN]);

pub fn derive_auth_key(password: &[u8], salt: &[u8]) -> Result<DerivedKey, KdfError> {
    derive_with_context(password, salt, CONTEXT_AUTH)
}

pub fn derive_master_key(password: &[u8], salt: &[u8]) -> Result<DerivedKey, KdfError> {
    derive_with_context(password, salt, CONTEXT_ENC)
}

fn derive_with_context(password: &[u8], salt: &[u8], context: &[u8]) -> Result<DerivedKey, KdfError> {
    if salt.len() != SALT_LEN {
        return Err(KdfError::Salt(salt.len()));
    }
    // Concatenate context label into password input so both derivations use
    // the same Argon2id parameters but produce independent outputs.
    let mut combined = Vec::with_capacity(password.len() + 1 + context.len());
    combined.extend_from_slice(password);
    combined.push(0x1F); // unit separator
    combined.extend_from_slice(context);

    let mut salt_arr = [0u8; SALT_LEN];
    salt_arr.copy_from_slice(salt);

    // dryoc PwHash with sensitive params: t=3, m=64MiB, p=4
    let pw = PwHash::<VecPwHash, _>::hash_with_params(
        &combined,
        Salt::from(salt_arr),
        3,                  // t (operations)
        64 * 1024 * 1024,   // m (memory in bytes)
    ).map_err(|e| KdfError::Hash(e.to_string()))?;

    let mut key = [0u8; KEY_LEN];
    let bytes = pw.into_parts();
    if bytes.len() < KEY_LEN {
        return Err(KdfError::Hash("derived bytes too short".into()));
    }
    key.copy_from_slice(&bytes[..KEY_LEN]);

    combined.zeroize();
    Ok(DerivedKey(key))
}

pub fn random_salt() -> [u8; SALT_LEN] {
    use dryoc::rng::randombytes_buf;
    let mut s = [0u8; SALT_LEN];
    randombytes_buf(&mut s);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_and_master_keys_are_independent_for_same_password_and_salt() {
        let pwd = b"correct horse battery staple";
        let salt = random_salt();
        let a = derive_auth_key(pwd, &salt).unwrap();
        let m = derive_master_key(pwd, &salt).unwrap();
        assert_ne!(a.0, m.0, "context labels must produce distinct keys");
    }

    #[test]
    fn deterministic_for_same_inputs() {
        let pwd = b"hunter2";
        let salt = [0u8; SALT_LEN];
        let a1 = derive_auth_key(pwd, &salt).unwrap();
        let a2 = derive_auth_key(pwd, &salt).unwrap();
        assert_eq!(a1.0, a2.0);
    }

    #[test]
    fn rejects_wrong_salt_length() {
        let r = derive_auth_key(b"x", &[0u8; 8]);
        assert!(matches!(r, Err(KdfError::Salt(8))));
    }
}
```

- [ ] **Step 2: Run, expect PASS**

```bash
cd desktop/src-tauri && cargo test --lib kdf
```

Expected: 3 passed. Note: each test takes ~1-2 seconds because of the 64 MiB memory cost.

- [ ] **Step 3: Add `thiserror` to Cargo.toml**

```toml
thiserror = "1"
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/crypto/kdf.rs desktop/src-tauri/Cargo.toml
git commit -m "feat(crypto): Argon2id KDF with auth/master context separation"
```

---

## Task 2: Crypto AEAD — XChaCha20-Poly1305

**Files:**
- Create: `desktop/src-tauri/src/crypto/aead.rs`

- [ ] **Step 1: Write tests + impl together**

```rust
// desktop/src-tauri/src/crypto/aead.rs
use dryoc::classic::crypto_secretbox_xchacha20poly1305 as cb;
use dryoc::rng::randombytes_buf;
use zeroize::Zeroize;

pub const NONCE_LEN: usize = cb::NONCEBYTES;     // 24
pub const TAG_LEN: usize = cb::MACBYTES;          // 16
pub const KEY_LEN: usize = cb::KEYBYTES;          // 32

#[derive(Debug, thiserror::Error)]
pub enum AeadError {
    #[error("encrypt failed")]
    Encrypt,
    #[error("decrypt failed: tag mismatch or corrupted ciphertext")]
    Decrypt,
    #[error("ciphertext too short")]
    TooShort,
}

/// Layout: nonce (24) || ciphertext || tag (16). Returned as one blob.
pub fn encrypt(plaintext: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>, AeadError> {
    let mut nonce = [0u8; NONCE_LEN];
    randombytes_buf(&mut nonce);
    let mut out = vec![0u8; plaintext.len() + TAG_LEN];
    cb::crypto_secretbox_xchacha20poly1305_easy(&mut out, plaintext, &nonce, key)
        .map_err(|_| AeadError::Encrypt)?;
    let mut framed = Vec::with_capacity(NONCE_LEN + out.len());
    framed.extend_from_slice(&nonce);
    framed.extend_from_slice(&out);
    Ok(framed)
}

pub fn decrypt(framed: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>, AeadError> {
    if framed.len() < NONCE_LEN + TAG_LEN {
        return Err(AeadError::TooShort);
    }
    let (nonce_slice, ciphertext) = framed.split_at(NONCE_LEN);
    let mut nonce = [0u8; NONCE_LEN];
    nonce.copy_from_slice(nonce_slice);
    let mut plaintext = vec![0u8; ciphertext.len() - TAG_LEN];
    cb::crypto_secretbox_xchacha20poly1305_open_easy(&mut plaintext, ciphertext, &nonce, key)
        .map_err(|_| AeadError::Decrypt)?;
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [7u8; KEY_LEN];
        let pt = b"top secret SSH password";
        let ct = encrypt(pt, &key).unwrap();
        assert!(ct.len() >= NONCE_LEN + TAG_LEN);
        let dec = decrypt(&ct, &key).unwrap();
        assert_eq!(dec, pt);
    }

    #[test]
    fn tampered_byte_rejected() {
        let key = [9u8; KEY_LEN];
        let mut ct = encrypt(b"data", &key).unwrap();
        ct[NONCE_LEN] ^= 0x01; // flip a ciphertext bit
        assert!(matches!(decrypt(&ct, &key), Err(AeadError::Decrypt)));
    }

    #[test]
    fn wrong_key_rejected() {
        let pt = b"data";
        let ct = encrypt(pt, &[1u8; KEY_LEN]).unwrap();
        assert!(matches!(decrypt(&ct, &[2u8; KEY_LEN]), Err(AeadError::Decrypt)));
    }

    #[test]
    fn distinct_nonces_for_same_input() {
        let key = [3u8; KEY_LEN];
        let a = encrypt(b"x", &key).unwrap();
        let b = encrypt(b"x", &key).unwrap();
        assert_ne!(a[..NONCE_LEN], b[..NONCE_LEN]);
    }
}
```

- [ ] **Step 2: Run**

```bash
cargo test --lib aead
```

Expected: 4 passed.

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/crypto/aead.rs
git commit -m "feat(crypto): XChaCha20-Poly1305 AEAD with random per-blob nonces"
```

---

## Task 3: Crypto BIP39 recovery wrapper

**Files:**
- Create: `desktop/src-tauri/src/crypto/bip39_recovery.rs`

- [ ] **Step 1: Write impl + tests**

```rust
// desktop/src-tauri/src/crypto/bip39_recovery.rs
use bip39::{Language, Mnemonic, MnemonicType, Seed};
use zeroize::Zeroize;

use crate::crypto::aead::{decrypt, encrypt, KEY_LEN};

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("invalid mnemonic phrase")]
    InvalidPhrase,
    #[error(transparent)]
    Aead(#[from] crate::crypto::aead::AeadError),
}

/// Generate a 24-word BIP39 phrase. Word count = 24 = 256 bits of entropy.
pub fn generate_phrase() -> String {
    let mn = Mnemonic::new(MnemonicType::Words24, Language::English);
    mn.into_phrase()
}

/// Derive a 32-byte recovery key from a 24-word phrase.
/// Uses BIP39 seed (PBKDF2-HMAC-SHA512) with empty passphrase, takes first 32 bytes.
pub fn derive_recovery_key(phrase: &str) -> Result<[u8; KEY_LEN], RecoveryError> {
    let mn = Mnemonic::from_phrase(phrase, Language::English)
        .map_err(|_| RecoveryError::InvalidPhrase)?;
    let seed = Seed::new(&mn, "");
    let bytes = seed.as_bytes();
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&bytes[..KEY_LEN]);
    Ok(key)
}

/// Wrap (encrypt) a master key with a recovery key derived from BIP39 phrase.
pub fn wrap_master_key(master_key: &[u8; KEY_LEN], phrase: &str) -> Result<Vec<u8>, RecoveryError> {
    let mut rec = derive_recovery_key(phrase)?;
    let result = encrypt(master_key, &rec)?;
    rec.zeroize();
    Ok(result)
}

/// Unwrap a stored recovery_blob using the BIP39 phrase.
pub fn unwrap_master_key(recovery_blob: &[u8], phrase: &str) -> Result<[u8; KEY_LEN], RecoveryError> {
    let mut rec = derive_recovery_key(phrase)?;
    let plaintext = decrypt(recovery_blob, &rec)?;
    rec.zeroize();
    if plaintext.len() != KEY_LEN {
        return Err(RecoveryError::Aead(crate::crypto::aead::AeadError::TooShort));
    }
    let mut master = [0u8; KEY_LEN];
    master.copy_from_slice(&plaintext);
    Ok(master)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_returns_24_words() {
        let phrase = generate_phrase();
        assert_eq!(phrase.split_whitespace().count(), 24);
    }

    #[test]
    fn wrap_unwrap_roundtrip() {
        let master = [42u8; KEY_LEN];
        let phrase = generate_phrase();
        let blob = wrap_master_key(&master, &phrase).unwrap();
        let recovered = unwrap_master_key(&blob, &phrase).unwrap();
        assert_eq!(master, recovered);
    }

    #[test]
    fn wrong_phrase_fails_to_unwrap() {
        let master = [1u8; KEY_LEN];
        let phrase = generate_phrase();
        let blob = wrap_master_key(&master, &phrase).unwrap();
        let other = generate_phrase();
        assert!(unwrap_master_key(&blob, &other).is_err());
    }

    #[test]
    fn invalid_mnemonic_returns_error() {
        let r = derive_recovery_key("not a valid phrase");
        assert!(matches!(r, Err(RecoveryError::InvalidPhrase)));
    }
}
```

- [ ] **Step 2: Run**

```bash
cargo test --lib bip39_recovery
```

Expected: 4 passed.

- [ ] **Step 3: Wire `mod` declarations**

`desktop/src-tauri/src/crypto/mod.rs`:

```rust
pub mod aead;
pub mod bip39_recovery;
pub mod kdf;
```

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/crypto/
git commit -m "feat(crypto): BIP39 24-word recovery — wrap/unwrap master key"
```

---

## Task 4: OS keychain integration

**Files:**
- Create: `desktop/src-tauri/src/keychain/mod.rs`

- [ ] **Step 1: Write impl + tests**

```rust
// desktop/src-tauri/src/keychain/mod.rs
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use keyring::Entry;
use zeroize::Zeroize;

const SERVICE: &str = "com.sdmp.desktop";

#[derive(Debug, thiserror::Error)]
pub enum KeychainError {
    #[error(transparent)]
    Keyring(#[from] keyring::Error),
    #[error("base64 decode failed")]
    Decode,
}

fn entry_for(user_id: &str) -> Result<Entry, KeychainError> {
    Ok(Entry::new(SERVICE, user_id)?)
}

pub fn store_master_key(user_id: &str, key: &[u8; 32]) -> Result<(), KeychainError> {
    let encoded = B64.encode(key);
    entry_for(user_id)?.set_password(&encoded)?;
    Ok(())
}

pub fn load_master_key(user_id: &str) -> Result<Option<[u8; 32]>, KeychainError> {
    match entry_for(user_id)?.get_password() {
        Ok(s) => {
            let mut bytes = B64.decode(s.as_bytes()).map_err(|_| KeychainError::Decode)?;
            if bytes.len() != 32 {
                bytes.zeroize();
                return Err(KeychainError::Decode);
            }
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            bytes.zeroize();
            Ok(Some(key))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn forget_master_key(user_id: &str) -> Result<(), KeychainError> {
    match entry_for(user_id)?.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires OS keychain; run manually with --ignored"]
    fn keychain_roundtrip() {
        let user = "test_user_id_for_unit_tests";
        let key = [13u8; 32];
        store_master_key(user, &key).unwrap();
        let loaded = load_master_key(user).unwrap().unwrap();
        assert_eq!(loaded, key);
        forget_master_key(user).unwrap();
        assert!(load_master_key(user).unwrap().is_none());
    }
}
```

- [ ] **Step 2: Add `base64` to Cargo.toml**

```toml
base64 = "0.22"
```

- [ ] **Step 3: Run**

```bash
cargo test --lib keychain
```

Expected: 0 passed, 1 ignored (OS keychain access requires user interaction in CI; run manually).

- [ ] **Step 4: Manual verification**

```bash
cargo test --lib keychain -- --ignored --nocapture
```

Expected: passes locally with no prompt (macOS may prompt for keychain access on first run; allow always for "SDMP" service).

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/src/keychain/mod.rs desktop/src-tauri/Cargo.toml
git commit -m "feat(keychain): cross-platform master key storage via keyring crate"
```

---

## Task 5: Encrypted local SQLite cache

**Files:**
- Create: `desktop/src-tauri/src/sync/cache.rs`

- [ ] **Step 1: Write impl + schema**

```rust
// desktop/src-tauri/src/sync/cache.rs
use rusqlite::{params, Connection, OpenFlags};
use std::path::Path;
use zeroize::Zeroize;

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// Open or create the local cache, encrypted with `key` (32 bytes derived from master).
/// SQLCipher requires the key as a hex string of 64 chars.
pub fn open(path: &Path, key: &[u8; 32]) -> Result<Connection, CacheError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
    )?;
    let mut hex = String::with_capacity(64);
    for b in key.iter() {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    conn.pragma_update(None, "key", format!("x'{}'", hex))?;
    hex.zeroize();
    apply_schema(&conn)?;
    Ok(conn)
}

fn apply_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(r#"
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rows (
            table_name TEXT NOT NULL,
            id TEXT NOT NULL,
            version INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            fields TEXT,
            PRIMARY KEY (table_name, id)
        );
        CREATE TABLE IF NOT EXISTS blob_cache (
            id TEXT PRIMARY KEY,
            blob_kind TEXT NOT NULL,
            ciphertext BLOB NOT NULL,
            version INTEGER NOT NULL,
            updated_at TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0
        );
    "#)?;
    Ok(())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?1, ?2)", params![key, value])?;
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0)).ok().map_or(Ok(None), |v| Ok(Some(v)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn open_and_read_back() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.db");
        let key = [42u8; 32];
        let conn = open(&path, &key).unwrap();
        set_meta(&conn, "version", "5").unwrap();
        drop(conn);
        let conn = open(&path, &key).unwrap();
        assert_eq!(get_meta(&conn, "version").unwrap().as_deref(), Some("5"));
    }

    #[test]
    fn wrong_key_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cache.db");
        let conn = open(&path, &[1u8; 32]).unwrap();
        set_meta(&conn, "k", "v").unwrap();
        drop(conn);
        // Open with wrong key - querying must error (or return garbage which we treat as error)
        let conn = open(&path, &[2u8; 32]).unwrap();
        let r: rusqlite::Result<i64> = conn.query_row("SELECT count(*) FROM meta", [], |r| r.get(0));
        assert!(r.is_err(), "wrong key should fail to read encrypted DB");
    }
}
```

- [ ] **Step 2: Add `tempfile` dev-dependency**

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Run**

```bash
cargo test --lib cache
```

Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/sync/cache.rs desktop/src-tauri/Cargo.toml
git commit -m "feat(sync/cache): SQLCipher-backed local cache with key-derived encryption"
```

---

## Task 6: HTTP client wrapper for backend

**Files:**
- Create: `desktop/src-tauri/src/sync/http.rs`

- [ ] **Step 1: Implement**

Provides an authenticated `reqwest` client that carries the session cookie. Structure:

```rust
// desktop/src-tauri/src/sync/http.rs
use reqwest::{Client, ClientBuilder, cookie::Jar};
use std::sync::Arc;

#[derive(Clone)]
pub struct ApiClient {
    pub base_url: String,
    pub http: Client,
    pub jar: Arc<Jar>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("api error {status}: {body}")]
    Status { status: u16, body: String },
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let jar = Arc::new(Jar::default());
        let http = ClientBuilder::new()
            .cookie_provider(jar.clone())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self { base_url: base_url.into(), http, jar }
    }
}
```

Plus methods `register`, `login_start`, `login_finish`, `logout`, `me`, `sync_snapshot`, `sync_changes`, `blob_get`, `blob_put`, `blob_delete`, `audit_log`. Each calls server endpoints from Stage 1 and parses JSON.

- [ ] **Step 2: Test**

Use `wiremock` crate to spin up a fake backend and verify request shape (method, path, body, that cookies are sent on follow-up requests). Add to dev-deps:

```toml
wiremock = "0.6"
```

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/sync/http.rs desktop/src-tauri/Cargo.toml
git commit -m "feat(sync/http): authenticated reqwest client with cookie jar"
```

---

## Task 7: Sync client state machine

**Files:**
- Create: `desktop/src-tauri/src/sync/client.rs`

- [ ] **Step 1: Implement**

Thin orchestration wrapping `cache.rs` + `http.rs`:

```rust
// desktop/src-tauri/src/sync/client.rs
use crate::sync::{cache, http::ApiClient};
use rusqlite::Connection;

pub struct SyncClient {
    api: ApiClient,
    pub cache: Connection,
}

impl SyncClient {
    pub fn new(api: ApiClient, cache: Connection) -> Self {
        Self { api, cache }
    }

    /// Pull initial snapshot or incremental changes since last_seen_version.
    pub async fn pull(&self) -> Result<u64, anyhow::Error> {
        let last = cache::get_meta(&self.cache, "last_version")?
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let changes = self.api.sync_changes(last).await?;
        // Apply changes to cache table `rows`
        for row in &changes.rows {
            self.cache.execute(
                "INSERT OR REPLACE INTO rows(table_name, id, version, deleted, fields) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![row.table, row.id, row.version, row.deleted as i64, serde_json::to_string(&row.fields)?],
            )?;
        }
        // For each blob_id, GET and store in blob_cache
        for blob_id in &changes.blob_ids {
            let blob = self.api.blob_get(blob_id).await?;
            self.cache.execute(
                "INSERT OR REPLACE INTO blob_cache(id, blob_kind, ciphertext, version, updated_at, deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    blob.id, blob.blob_kind, blob.ciphertext, blob.version,
                    blob.updated_at, blob.deleted as i64,
                ],
            )?;
        }
        cache::set_meta(&self.cache, "last_version", &changes.version.to_string())?;
        Ok(changes.version)
    }
}
```

- [ ] **Step 2: Test with wiremock**

Mock server returns a snapshot response, assert client persists rows + blobs to local cache.

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/sync/client.rs desktop/src-tauri/src/sync/mod.rs
git commit -m "feat(sync/client): pull snapshot/changes into encrypted local cache"
```

---

## Task 8: Tauri commands for auth

**Files:**
- Create: `desktop/src-tauri/src/commands/auth.rs`
- Modify: `desktop/src-tauri/src/lib.rs` (register commands)

- [ ] **Step 1: Implement command stubs**

```rust
// desktop/src-tauri/src/commands/auth.rs
use crate::crypto::{aead, bip39_recovery, kdf};
use crate::keychain;
use crate::sync::http::ApiClient;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("kdf: {0}")] Kdf(String),
    #[error("aead: {0}")] Aead(String),
    #[error("recovery: {0}")] Recovery(String),
    #[error("api: {0}")] Api(String),
    #[error("keychain: {0}")] Keychain(String),
}

impl From<kdf::KdfError> for CommandError { fn from(e: kdf::KdfError) -> Self { Self::Kdf(e.to_string()) } }
impl From<aead::AeadError> for CommandError { fn from(e: aead::AeadError) -> Self { Self::Aead(e.to_string()) } }
impl From<bip39_recovery::RecoveryError> for CommandError { fn from(e: bip39_recovery::RecoveryError) -> Self { Self::Recovery(e.to_string()) } }

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
    let resp = api
        .register(&email, &salt, &auth_key.0, &recovery_blob)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::store_master_key(&resp.user_id, &master_key.0).map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(RegisterResult { user_id: resp.user_id, recovery_phrase: phrase })
}

#[tauri::command]
pub async fn auth_login(
    email: String,
    password: String,
    totp_code: Option<String>,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let start = api.login_start(&email).await.map_err(|e| CommandError::Api(e.to_string()))?;
    let auth_key = kdf::derive_auth_key(password.as_bytes(), &start.salt)?;
    let master_key = kdf::derive_master_key(password.as_bytes(), &start.salt)?;
    let resp = api.login_finish(&email, &auth_key.0, totp_code.as_deref()).await.map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::store_master_key(&resp.user_id, &master_key.0).map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(resp.user_id)
}

#[tauri::command]
pub async fn auth_logout(api: State<'_, ApiClient>, user_id: String) -> Result<(), CommandError> {
    api.logout().await.map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::forget_master_key(&user_id).map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn auth_recovery(
    email: String,
    phrase: String,
    new_password: String,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let start = api.recovery_start(&email).await.map_err(|e| CommandError::Api(e.to_string()))?;
    let master_key = bip39_recovery::unwrap_master_key(&start.recovery_blob, &phrase)?;
    let new_salt = kdf::random_salt();
    let new_auth = kdf::derive_auth_key(new_password.as_bytes(), &new_salt)?;
    let new_master = kdf::derive_master_key(new_password.as_bytes(), &new_salt)?;
    // Decrypt master_key was needed to re-encrypt blobs — defer blob re-encryption to follow-up sync push.
    // For recovery, we keep recovery_blob bound to original phrase; rewrap master_key with NEW master_key
    // is unnecessary because recovery key derives from PHRASE, not master.
    // What we send: new salt, new auth_key_hash, and a re-wrapped recovery_blob that still binds the same phrase
    // to the (potentially new) master if the user opted to rotate. For MVP: keep same master key, just change auth.
    let new_recovery = bip39_recovery::wrap_master_key(&master_key, &phrase)?;
    let resp = api.recovery_finish(&email, &new_salt, &new_auth.0, &new_recovery)
        .await.map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::store_master_key(&resp.user_id, &master_key).map_err(|e| CommandError::Keychain(e.to_string()))?;
    let _ = new_master; // currently unused; reserved for future "rotate master on recovery" flow
    Ok(resp.user_id)
}
```

(API client method signatures: `register(email, salt, auth_key, recovery_blob) -> {user_id}`, `login_start(email) -> {salt}`, `login_finish(email, auth_key, totp_code) -> {user_id}`. Implement as `pub async fn` on `ApiClient`.)

- [ ] **Step 2: Register commands in `lib.rs`**

```rust
use crate::sync::http::ApiClient;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt().with_env_filter(EnvFilter::from_default_env()).init();
    let api = ApiClient::new(std::env::var("SDMP_API_URL").unwrap_or_else(|_| "http://localhost:8100/api".into()));
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(api)
        .invoke_handler(tauri::generate_handler![
            commands::auth::auth_register,
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_recovery,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Test integration via Tauri's mock harness**

Tauri 2 provides `tauri::test::mock_app` for invoking commands without a window. Add an integration test under `desktop/src-tauri/tests/auth_commands.rs` that registers + logs in against a wiremock backend.

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/src/commands/ desktop/src-tauri/src/lib.rs
git commit -m "feat(commands/auth): register, login, logout, recovery via Tauri commands"
```

---

## Task 9: Tauri commands for vault (blob CRUD)

**Files:**
- Create: `desktop/src-tauri/src/commands/vault.rs`

- [ ] **Step 1: Implement**

```rust
// desktop/src-tauri/src/commands/vault.rs
use crate::commands::auth::CommandError;
use crate::crypto::aead;
use crate::keychain;
use crate::sync::http::ApiClient;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::State;

#[tauri::command]
pub async fn vault_decrypt_blob(
    user_id: String,
    blob_id: String,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let blob = api.blob_get(&blob_id).await.map_err(|e| CommandError::Api(e.to_string()))?;
    let raw = B64.decode(blob.ciphertext_b64.as_bytes()).map_err(|_| CommandError::Aead("b64".into()))?;
    let plaintext = aead::decrypt(&raw, &key)?;
    Ok(B64.encode(plaintext))
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
    let pt = B64.decode(plaintext_b64.as_bytes()).map_err(|_| CommandError::Aead("b64".into()))?;
    let ct = aead::encrypt(&pt, &key)?;
    api.blob_put(&blob_id, &blob_kind, &ct).await.map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn vault_delete_blob(blob_id: String, api: State<'_, ApiClient>) -> Result<(), CommandError> {
    api.blob_delete(&blob_id).await.map_err(|e| CommandError::Api(e.to_string()))
}
```

- [ ] **Step 2: Register in `lib.rs`** alongside auth commands.

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/src/commands/vault.rs desktop/src-tauri/src/lib.rs
git commit -m "feat(commands/vault): blob put/get/delete via master key from keychain"
```

---

## Task 10: Tauri command for sync

**Files:**
- Create: `desktop/src-tauri/src/commands/sync.rs`

- [ ] **Step 1: Implement**

```rust
// desktop/src-tauri/src/commands/sync.rs
use crate::commands::auth::CommandError;
use crate::sync::client::SyncClient;
use std::sync::Mutex;
use tauri::State;

pub struct SyncHandle(pub Mutex<Option<SyncClient>>);

#[tauri::command]
pub async fn sync_now(handle: State<'_, SyncHandle>) -> Result<u64, CommandError> {
    let mut guard = handle.0.lock().unwrap();
    let client = guard.as_mut().ok_or_else(|| CommandError::Api("not initialized".into()))?;
    client.pull().await.map_err(|e| CommandError::Api(e.to_string()))
}
```

(For brevity, the wiring of `SyncHandle` initialization on login is left as part of `lib.rs::run` — initialize after first successful login when user_id and master key are known.)

- [ ] **Step 2: Commit**

```bash
git add desktop/src-tauri/src/commands/sync.rs
git commit -m "feat(commands/sync): manual sync trigger"
```

---

## Task 11: Frontend auth UI

**Files:**
- Create: `frontend/src/store/auth.ts`
- Create: `frontend/src/lib/runtime.ts`
- Create: `frontend/src/lib/tauri-invoke.ts`
- Create: `frontend/src/pages/Register.tsx`
- Create: `frontend/src/pages/Login.tsx`
- Create: `frontend/src/pages/RecoverySetup.tsx` (display BIP39 + force user to type back 4 random words)
- Create: `frontend/src/pages/RecoveryRestore.tsx`
- Create: `frontend/src/pages/Lock.tsx`
- Modify: `frontend/src/App.tsx` (add routes, RequireAuth guard)
- Modify: `frontend/src/main.tsx` (provider order)
- Modify: `frontend/package.json` (add `@tauri-apps/api`)

- [ ] **Step 1: Add Tauri API package**

```bash
cd frontend && npm install @tauri-apps/api
```

- [ ] **Step 2: Runtime detector**

`frontend/src/lib/runtime.ts`:

```typescript
export function isTauri(): boolean {
  // Tauri 2 sets this on window
  // @ts-expect-error - injected by Tauri
  return Boolean(window.__TAURI_INTERNALS__);
}
```

- [ ] **Step 3: Invoke wrapper**

`frontend/src/lib/tauri-invoke.ts`:

```typescript
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./runtime";

export async function invokeIfTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`${cmd} requires the desktop app`);
  }
  return invoke<T>(cmd, args);
}
```

- [ ] **Step 4: Auth store**

`frontend/src/store/auth.ts`:

```typescript
import { create } from "zustand";

interface AuthState {
  userId: string | null;
  email: string | null;
  unlocked: boolean;
  setUser(userId: string, email: string): void;
  setUnlocked(v: boolean): void;
  clear(): void;
}

export const useAuthStore = create<AuthState>((set) => ({
  userId: null,
  email: null,
  unlocked: false,
  setUser: (userId, email) => set({ userId, email }),
  setUnlocked: (v) => set({ unlocked: v }),
  clear: () => set({ userId: null, email: null, unlocked: false }),
}));
```

- [ ] **Step 5: Register page (desktop only)**

`frontend/src/pages/Register.tsx`: form with email + master password + confirm. Calls `invokeIfTauri('auth_register', { email, password })`. On success, navigates to `RecoverySetup` showing the BIP39 phrase. Web shows "Open in desktop to register" CTA.

`RecoverySetup.tsx`: displays the 24-word phrase in a 4×6 grid. Below: 4 input fields, each labeled with a randomly chosen word index (e.g., "Word 7", "Word 13", "Word 18", "Word 22"). User must type those 4 back; on success, "I've saved my recovery phrase" button enables, navigates to `/dashboard`.

`Login.tsx`: email + master password + optional TOTP. Calls `auth_login`. On success, store userId and navigate to dashboard.

`RecoveryRestore.tsx`: email + 24-word phrase (24 inputs) + new password. Calls `auth_recovery`. On success, navigates to login.

`Lock.tsx`: when session is alive but master key not in memory (e.g., after explicit lock), prompt for master password again, derive locally, store in keychain.

- [ ] **Step 6: Routes and guards**

`frontend/src/App.tsx`:

```typescript
import { Routes, Route, Navigate } from "react-router-dom";
import Register from "./pages/Register";
import RecoverySetup from "./pages/RecoverySetup";
import Login from "./pages/Login";
import RecoveryRestore from "./pages/RecoveryRestore";
import Lock from "./pages/Lock";
import Domains from "./pages/Domains";
// ... existing imports
import { useAuthStore } from "./store/auth";

function RequireAuth({ children }: { children: JSX.Element }) {
  const { userId, unlocked } = useAuthStore();
  if (!userId) return <Navigate to="/login" replace />;
  if (!unlocked) return <Navigate to="/lock" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/recovery-setup" element={<RecoverySetup />} />
      <Route path="/recover" element={<RecoveryRestore />} />
      <Route path="/lock" element={<Lock />} />
      <Route path="/domains" element={<RequireAuth><Domains /></RequireAuth>} />
      {/* ... other existing protected routes */}
      <Route path="/" element={<Navigate to="/domains" replace />} />
    </Routes>
  );
}
```

- [ ] **Step 7: Vitest unit tests for auth store**

`frontend/src/store/auth.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { useAuthStore } from "./auth";

describe("authStore", () => {
  it("sets and clears user", () => {
    useAuthStore.getState().setUser("u1", "u@e.com");
    expect(useAuthStore.getState().userId).toBe("u1");
    useAuthStore.getState().clear();
    expect(useAuthStore.getState().userId).toBeNull();
  });
});
```

Add `vitest` to devDependencies and a `test` script:

```bash
cd frontend && npm install -D vitest @vitest/ui jsdom
```

```json
"scripts": { "test": "vitest run" }
```

Run: `npm test`. Expected: 1 passed.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/ frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): auth pages, recovery setup with BIP39 verification, route guards"
```

---

## Task 12: End-to-end smoke

**Files:**
- Test (manual): no file

- [ ] **Step 1: Start backend**

```bash
cd backend && uvicorn app.main:app --port 8100
```

- [ ] **Step 2: Start desktop**

```bash
cd desktop && SDMP_API_URL=http://localhost:8100/api npm run tauri dev
```

- [ ] **Step 3: Register flow**

In the desktop window:
1. Click "Register".
2. Enter email + password.
3. Submit. Wait ~5 seconds (Argon2id).
4. See 24-word BIP39 phrase.
5. Type back the 4 randomly-asked words.
6. Confirm email via dev log (`docker compose logs backend | grep "DEV email"` to find the link).
7. Visit confirm link in browser; expect 200.
8. Log out.

- [ ] **Step 4: Login + lock + unlock**

1. Log in with email + password. Dashboard renders metadata-only views.
2. Click lock icon. Should redirect to `/lock`.
3. Enter master password again. Master key is re-derived and re-stored in keychain.

- [ ] **Step 5: Recovery**

1. Log out.
2. Click "Forgot password?". Enter email + 24-word phrase + new password.
3. Should restore access. Old password no longer works; new one does.

- [ ] **Step 6: Document failures**

Any failure = file an issue against this plan and fix before declaring Stage 2 complete.

---

## Stage 2 verification

```bash
# Rust unit tests
cd desktop/src-tauri && cargo test --lib
# Expected: kdf, aead, bip39_recovery, cache pass; keychain ignored

# Frontend
cd ../../frontend && npm test
# Expected: vitest passes

# Backend (re-run from Stage 1)
cd ../backend && pytest -v
# Expected: all green

# Manual smoke (above) all 6 steps pass
```

Stage 2 is complete when:
- Rust unit tests for crypto primitives all pass.
- Auth store vitest passes.
- Manual register → save phrase → confirm email → login → lock → unlock → logout → recover round-trip works end-to-end.
- Master key never persists to disk in plaintext (verify by `strings ~/Library/Application\ Support/com.sdmp.desktop/cache.db | grep -i password` — returns nothing).

Move to [Stage 3](./2026-05-06-stage-3-desktop-ssh-integrations.md).
