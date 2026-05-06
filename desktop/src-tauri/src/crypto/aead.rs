use dryoc::classic::crypto_secretbox::{crypto_secretbox_easy, crypto_secretbox_open_easy, Key, Nonce};
use dryoc::constants::{CRYPTO_SECRETBOX_KEYBYTES, CRYPTO_SECRETBOX_MACBYTES, CRYPTO_SECRETBOX_NONCEBYTES};

pub const NONCE_LEN: usize = CRYPTO_SECRETBOX_NONCEBYTES;
pub const TAG_LEN: usize = CRYPTO_SECRETBOX_MACBYTES;
pub const KEY_LEN: usize = CRYPTO_SECRETBOX_KEYBYTES;

#[derive(Debug, thiserror::Error)]
pub enum AeadError {
    #[error("encrypt failed")]
    Encrypt,
    #[error("decrypt failed: tag mismatch or corrupted ciphertext")]
    Decrypt,
    #[error("ciphertext too short")]
    TooShort,
}

/// Layout: nonce (24) || libsodium secretbox easy blob (mac || ciphertext).
pub fn encrypt(plaintext: &[u8], key: &Key) -> Result<Vec<u8>, AeadError> {
    let mut nonce = Nonce::default();
    dryoc::rng::copy_randombytes(&mut nonce);
    let mut boxed = vec![0u8; plaintext.len() + TAG_LEN];
    crypto_secretbox_easy(&mut boxed, plaintext, &nonce, key).map_err(|_| AeadError::Encrypt)?;
    let mut framed = Vec::with_capacity(NONCE_LEN + boxed.len());
    framed.extend_from_slice(&nonce);
    framed.extend_from_slice(&boxed);
    Ok(framed)
}

pub fn decrypt(framed: &[u8], key: &Key) -> Result<Vec<u8>, AeadError> {
    if framed.len() < NONCE_LEN + TAG_LEN {
        return Err(AeadError::TooShort);
    }
    let (nonce_slice, boxed) = framed.split_at(NONCE_LEN);
    let mut nonce = Nonce::default();
    nonce.copy_from_slice(nonce_slice);
    if boxed.len() < TAG_LEN {
        return Err(AeadError::TooShort);
    }
    let mut plaintext = vec![0u8; boxed.len() - TAG_LEN];
    crypto_secretbox_open_easy(&mut plaintext, boxed, &nonce, key).map_err(|_| AeadError::Decrypt)?;
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
        ct[NONCE_LEN] ^= 0x01;
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
