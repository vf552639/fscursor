use bip39::{Language, Mnemonic, MnemonicType, Seed};
use zeroize::Zeroize;

use crate::crypto::aead::{decrypt, encrypt, KEY_LEN};

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("invalid mnemonic phrase")]
    InvalidPhrase,
    #[error("invalid wrapped vault key length")]
    BadPlaintextLength,
    #[error(transparent)]
    Aead(#[from] crate::crypto::aead::AeadError),
}

pub fn generate_phrase() -> String {
    let mn = Mnemonic::new(MnemonicType::Words24, Language::English);
    mn.phrase().to_string()
}

pub fn derive_recovery_key(phrase: &str) -> Result<[u8; KEY_LEN], RecoveryError> {
    let mn = Mnemonic::from_phrase(phrase, Language::English).map_err(|_| RecoveryError::InvalidPhrase)?;
    let seed = Seed::new(&mn, "");
    let bytes = seed.as_bytes();
    let mut key = [0u8; KEY_LEN];
    key.copy_from_slice(&bytes[..KEY_LEN]);
    Ok(key)
}

/// Оборачивает КЛЮЧ ХРАНИЛИЩА (VK): именно им зашифрованы блобы, и именно он обязан
/// выйти из блоба при восстановлении.
///
/// Переименовано из `wrap_master_key` вместе со сменой смысла: мастер-ключ (KEK) сюда
/// больше не попадает. Формат на диске от переименования не зависит — имя Rust-функции
/// в блоб не входит, в отличие от `SERVICE` в связке ключей и метки контекста
/// `sdmp-master-key-v1`, которые поэтому и остались как были.
pub fn wrap_vault_key(vault_key: &[u8; KEY_LEN], phrase: &str) -> Result<Vec<u8>, RecoveryError> {
    let mut rec = derive_recovery_key(phrase)?;
    let result = encrypt(vault_key, &rec)?;
    rec.zeroize();
    Ok(result)
}

pub fn unwrap_vault_key(recovery_blob: &[u8], phrase: &str) -> Result<[u8; KEY_LEN], RecoveryError> {
    let mut rec = derive_recovery_key(phrase)?;
    let mut plaintext = decrypt(recovery_blob, &rec)?;
    rec.zeroize();
    if plaintext.len() != KEY_LEN {
        plaintext.zeroize();
        return Err(RecoveryError::BadPlaintextLength);
    }
    let mut vault_key = [0u8; KEY_LEN];
    vault_key.copy_from_slice(&plaintext);
    // Куча под расшифровку — вторая копия VK; освобождать её как есть нельзя.
    plaintext.zeroize();
    Ok(vault_key)
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
        let vault_key = [42u8; KEY_LEN];
        let phrase = generate_phrase();
        let blob = wrap_vault_key(&vault_key, &phrase).unwrap();
        let recovered = unwrap_vault_key(&blob, &phrase).unwrap();
        assert_eq!(vault_key, recovered);
    }

    #[test]
    fn wrong_phrase_fails_to_unwrap() {
        let vault_key = [1u8; KEY_LEN];
        let phrase = generate_phrase();
        let blob = wrap_vault_key(&vault_key, &phrase).unwrap();
        let other = generate_phrase();
        assert!(unwrap_vault_key(&blob, &other).is_err());
    }

    #[test]
    fn invalid_mnemonic_returns_error() {
        let r = derive_recovery_key("not a valid phrase");
        assert!(matches!(r, Err(RecoveryError::InvalidPhrase)));
    }
}
