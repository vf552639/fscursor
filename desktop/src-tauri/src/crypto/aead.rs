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

/// A fresh random key. This is how a vault key is born: it is chosen, never derived,
/// which is exactly what lets the password change without touching a single blob.
pub fn random_key() -> Key {
    let mut key = Key::default();
    dryoc::rng::copy_randombytes(&mut key);
    key
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

    /// Не «ключи разные» ради разности: одинаковые VK у двух аккаунтов означали бы,
    /// что обёртка одного открывает блобы другого.
    #[test]
    fn random_key_is_not_a_constant() {
        assert_ne!(random_key(), random_key());
        assert_ne!(random_key(), [0u8; KEY_LEN]);
    }

    #[test]
    fn distinct_nonces_for_same_input() {
        let key = [3u8; KEY_LEN];
        let a = encrypt(b"x", &key).unwrap();
        let b = encrypt(b"x", &key).unwrap();
        assert_ne!(a[..NONCE_LEN], b[..NONCE_LEN]);
    }

    /// Вторая половина тест-вектора обёртки; первая — в `frontend/src/lib/crypto.test.ts`.
    /// Keep in sync with it: те же байты, тот же KEK, тот же ожидаемый VK.
    ///
    /// Односторонний вектор сторожил бы только одну реализацию, а беда возможна ровно от
    /// расхождения ДВУХ: браузер, разворачивающий обёртку иначе, чем десктоп, никуда не
    /// падает — он молча отдаёт 32 байта мусора как ключ и показывает мусор там, где
    /// должен быть пароль. Поэтому одни и те же фиксированные байты обязаны открываться
    /// обеими сторонами, и обе стороны обязаны это проверять.
    ///
    /// KEK — фикстура `hunter2` + нулевая соль из `kdf.rs`
    /// (`master_key_fixture_for_browser_tests`), VK — байты 00..1f.
    #[test]
    fn wrapped_vault_key_fixture_matches_the_browser() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};

        let wrapped = B64
            .decode(
                "EBESExQVFhcYGRobHB0eHyAhIiMkJSYnb9WWEYFBWfrgYxJ9rQHFkE767KJCJ2xANXgOb/E4NJIVRoY3l7yuEYBeZ8jWxQ7k",
            )
            .expect("вектор должен быть валидным base64");
        assert_eq!(wrapped.len(), NONCE_LEN + TAG_LEN + KEY_LEN, "ровно 72 байта");

        let kek = crate::crypto::kdf::derive_master_key(b"hunter2", &[0u8; 16]).unwrap();
        let vk = decrypt(&wrapped, &kek.0).expect("обёртка обязана открываться этим KEK");
        assert_eq!(
            hex::encode(&vk),
            "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
        );
    }
}
