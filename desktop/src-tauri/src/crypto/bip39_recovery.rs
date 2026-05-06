use bip39::{Language, Mnemonic, MnemonicType, Seed};
use zeroize::Zeroize;

use crate::crypto::aead::{decrypt, encrypt, KEY_LEN};

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error("invalid mnemonic phrase")]
    InvalidPhrase,
    #[error("invalid wrapped master length")]
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

pub fn wrap_master_key(master_key: &[u8; KEY_LEN], phrase: &str) -> Result<Vec<u8>, RecoveryError> {
    let mut rec = derive_recovery_key(phrase)?;
    let result = encrypt(master_key, &rec)?;
    rec.zeroize();
    Ok(result)
}

pub fn unwrap_master_key(recovery_blob: &[u8], phrase: &str) -> Result<[u8; KEY_LEN], RecoveryError> {
    let mut rec = derive_recovery_key(phrase)?;
    let plaintext = decrypt(recovery_blob, &rec)?;
    rec.zeroize();
    if plaintext.len() != KEY_LEN {
        return Err(RecoveryError::BadPlaintextLength);
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
