use dryoc::pwhash::{Config, VecPwHash};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Per-context labels keep auth and encryption keys derivationally distinct.
const CONTEXT_AUTH: &[u8] = b"sdmp-auth-key-v1";
const CONTEXT_ENC: &[u8] = b"sdmp-master-key-v1";
/// Proof-of-phrase sent to `/auth/recovery/*`. Deliberately NOT the BIP-39 key from
/// `bip39_recovery::derive_recovery_key` — that one opens the recovery blob, so handing
/// it to the server would hand over the master key.
const CONTEXT_RECOVERY: &[u8] = b"sdmp-recovery-key-v1";

const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;

/// Fixed salt for the recovery auth key. Not `user.salt`: both `password/change` and
/// `recovery/finish` rotate it, so a salt-bound recovery key would invalidate itself
/// on every password change.
const RECOVERY_SALT: &[u8; SALT_LEN] = b"sdmp-recovery-v1";

#[derive(Debug, thiserror::Error)]
pub enum KdfError {
    #[error("kdf failed: {0}")]
    Hash(String),
    #[error("invalid salt length: {0}")]
    Salt(usize),
}

#[derive(Zeroize, ZeroizeOnDrop)]
pub struct DerivedKey(pub [u8; KEY_LEN]);

pub fn derive_auth_key(password: &[u8], salt: &[u8]) -> Result<DerivedKey, KdfError> {
    derive_with_context(password, salt, CONTEXT_AUTH)
}

/// The key-encryption key (KEK). Despite the name it no longer encrypts anything but
/// the vault key: blobs and the local cache are keyed by the VK, and this only wraps it
/// (`users.wrapped_vault_key`). The name and the `sdmp-master-key-v1` context label stay
/// as they are — the label is part of the wire format shared with the browser, and
/// renaming the function would say nothing the doc comment does not.
pub fn derive_master_key(password: &[u8], salt: &[u8]) -> Result<DerivedKey, KdfError> {
    derive_with_context(password, salt, CONTEXT_ENC)
}

/// Trim, collapse whitespace runs to a single space, ASCII-lowercase.
/// Must stay byte-identical to `normalizeRecoveryPhrase` in `frontend/src/lib/crypto.ts`.
pub fn normalize_recovery_phrase(phrase: &str) -> String {
    let mut out = String::with_capacity(phrase.len());
    for (i, word) in phrase.split_whitespace().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(word);
    }
    out.make_ascii_lowercase();
    out
}

/// Proof that the caller holds the recovery phrase. The server stores only its bcrypt hash.
pub fn derive_recovery_auth_key(phrase: &str) -> Result<DerivedKey, KdfError> {
    let normalized = normalize_recovery_phrase(phrase);
    derive_with_context(normalized.as_bytes(), RECOVERY_SALT, CONTEXT_RECOVERY)
}

fn derive_with_context(password: &[u8], salt: &[u8], context: &[u8]) -> Result<DerivedKey, KdfError> {
    if salt.len() != SALT_LEN {
        return Err(KdfError::Salt(salt.len()));
    }
    let mut combined = Vec::with_capacity(password.len() + 1 + context.len());
    combined.extend_from_slice(password);
    combined.push(0x1F);
    combined.extend_from_slice(context);

    let config = Config::interactive()
        .with_opslimit(3)
        .with_memlimit(64 * 1024 * 1024);

    let pw = VecPwHash::hash_with_salt(&combined, salt.to_vec(), config)
        .map_err(|e| KdfError::Hash(e.to_string()))?;

    let (hash_vec, _, _) = pw.into_parts();
    if hash_vec.len() < KEY_LEN {
        combined.zeroize();
        return Err(KdfError::Hash("derived bytes too short".into()));
    }
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&hash_vec[..KEY_LEN]);

    combined.zeroize();
    Ok(DerivedKey(key))
}

pub fn random_salt() -> [u8; SALT_LEN] {
    let mut s = [0u8; SALT_LEN];
    dryoc::rng::copy_randombytes(&mut s);
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

    /// The 24-word fixture used on both sides of the parity check.
    const FIXTURE_PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    #[test]
    fn recovery_auth_key_is_not_the_blob_key() {
        // The BIP-39 seed key decrypts the recovery blob; sending it to the server would
        // hand over the master key. These two must never coincide.
        let bip39 = crate::crypto::bip39_recovery::derive_recovery_key(FIXTURE_PHRASE).unwrap();
        let proof = derive_recovery_auth_key(FIXTURE_PHRASE).unwrap();
        assert_ne!(bip39, proof.0);
    }

    #[test]
    fn recovery_phrase_normalization_is_case_and_whitespace_insensitive() {
        assert_eq!(
            normalize_recovery_phrase("  Abandon\tABANDON\n  art  "),
            "abandon abandon art"
        );
        let a = derive_recovery_auth_key(FIXTURE_PHRASE).unwrap();
        let messy = format!("  {}  ", FIXTURE_PHRASE.replace(' ', "\n  ").to_uppercase());
        let b = derive_recovery_auth_key(&messy).unwrap();
        assert_eq!(a.0, b.0);
    }

    /// Base64(recovery auth key) for the fixture phrase.
    /// Keep in sync with `frontend/src/lib/crypto.test.ts` — a browser that derives a
    /// different key locks the user out of the account they set up on the desktop.
    #[test]
    fn recovery_auth_key_fixture_for_browser_tests() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        let k = derive_recovery_auth_key(FIXTURE_PHRASE).unwrap();
        assert_eq!(
            B64.encode(k.0),
            "reJBXXNBI6uFBH1umkSAzylaw8qSkV8PA2GPnlSBa+k="
        );
    }

    /// Hex(master key) for `hunter2` + zero salt; keep in sync with `frontend/src/lib/crypto.test.ts`.
    #[test]
    fn master_key_fixture_for_browser_tests() {
        let k = derive_master_key(b"hunter2", &[0u8; SALT_LEN]).unwrap();
        assert_eq!(
            hex::encode(k.0),
            "cf3489cf8dfa53ec6604068c99f63760b1c8faa9772c0862c2acd81fac43a7a4"
        );
    }
}
