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
    match entry_for(user_id)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Тест НЕ помечен `#[ignore]` намеренно, хотя и ходит в системное
    /// хранилище.
    ///
    /// Пока он был отключён, `keyring` стоял в `Cargo.toml` без платформенной
    /// фичи и собирался с mock-стором: `set_password` отвечал `Ok(())`, ничего
    /// не сохранив, а `get_password` — всегда `NoEntry`. Мастер-ключ не
    /// сохранялся ни разу, `vault_put_blob` падал на `keychain: locked`, и
    /// **ни один секрет нельзя было записать** — при 191 зелёном тесте.
    /// Единственный тест, который бы это поймал, стоял с `#[ignore]`.
    ///
    /// Цена возврата `#[ignore]` — ровно такая же дыра, поэтому его здесь быть
    /// не должно. Если в CI тест упрётся в заблокированную связку ключей,
    /// разблокировать её в раннере, а не глушить тест.
    #[test]
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
