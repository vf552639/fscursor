use dryoc::pwhash::{Config, VecPwHash};
use zeroize::{Zeroize, ZeroizeOnDrop};

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

#[derive(Zeroize, ZeroizeOnDrop)]
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
