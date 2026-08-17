use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use keyring::Entry;
use zeroize::Zeroize;

/// Имя записи в связке ключей: сервис + `user_id`. Переименование функций вокруг
/// (master key → vault key) его НЕ касается — сменить эту строку значит потерять
/// ключ на всех уже установленных копиях.
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

/// Сохранить ключ хранилища (VK) пользователя. Это UPSERT — и собран он вручную,
/// потому что `set_password` перестаёт быть upsert'ом при первой же осечке
/// ЧТЕНИЯ. Под капотом (`security-framework`, `SecKeychain::set_generic_password`):
///
/// ```ignore
/// match self.find_generic_password(service, account) {
///     Ok((_, mut item)) => item.set_password(password),            // обновить
///     _ => self.add_generic_password(service, account, password),  // вставить
/// }
/// ```
///
/// Ветка `_` глотает ЛЮБУЮ ошибку поиска, а не только «не найдено», — а поиск
/// запрашивает сами данные записи (`&mut data`) и потому требует авторизации
/// ACL. Запись есть, но ACL её нам не отдаёт → уходим на вставку → получаем
/// `errSecDuplicateItem`. Наружу это приезжало как «The specified item already
/// exists in the keychain»: сообщение уводит от причины (доступ, а не дубликат),
/// а вход встаёт намертво — перезайти нельзя, и что делать, не сказано.
///
/// КОГДА ЭТО СЛУЧАЕТСЯ. ACL опознаёт программу по подписи, а `.app` подписан
/// самоподписанным сертификатом (`desktop/dev-signing.sh`). Перевыпустили
/// сертификат — требование в ACL ссылается на прежний корень, и своя же запись
/// становится нечитаемой навсегда. Ровно так и вышло 14.08.2026: запись завели
/// в 12:42:41, сертификат перевыпустили в 12:46:15 (коммит `4202d44`), и с тех
/// пор `mdat` записи не двигался — ни один вход не проходил.
///
/// ПОЧЕМУ СНЕСТИ И ЗАПИСАТЬ ЗАНОВО — ЭТО ВЕРНО, А НЕ ОБХОД. Запись наша (сервис
/// = наш bundle id, аккаунт = наш `user_id`), а значение мы держим в руках прямо
/// сейчас и умеем добыть заново: VK лежит на сервере обёрнутым в KEK
/// (`users.wrapped_vault_key`), а KEK выводится из пароля и соли. Связка ключей
/// здесь — кеш, а не единственный экземпляр секрета, поэтому её перезапись
/// ничего не теряет.
///
/// Единственная копия VK — не здесь, а в recovery-блобе и серверной обёртке;
/// если когда-нибудь появится путь, кладущий сюда ключ, которого больше нигде
/// нет, эта ветка перестанет быть безопасной, и пересматривать придётся её.
///
/// ПОЧЕМУ ПОВТОР ГЕЙТИТСЯ УДАЛЕНИЕМ, А НЕ РАЗБОРОМ КОДА ОШИБКИ. Код
/// `errSecDuplicateItem` наружу не выходит: `keyring` прячет причину в
/// `PlatformFailure(Box<dyn Error>)`, а вылавливать её из текста — гадание,
/// которое сломается на другой локали или версии крейта. Удаление само по себе
/// достаточный гейт: оно проходит ровно тогда, когда запись есть и снять её нам
/// разрешено. Не прошло — возвращаем ИСХОДНУЮ ошибку записи, а не ошибку
/// удаления: спрашивали-то мы про запись, и подмена увела бы диагноз второй раз.
pub fn store_vault_key(user_id: &str, key: &[u8; 32]) -> Result<(), KeychainError> {
    let encoded = B64.encode(key);
    let first = match entry_for(user_id)?.set_password(&encoded) {
        Ok(()) => return Ok(()),
        Err(e) => e,
    };
    match entry_for(user_id)?.delete_credential() {
        // Запись снята — значит она и была помехой; заводим заново, уже с ACL
        // под нынешнюю подпись.
        Ok(()) => Ok(entry_for(user_id)?.set_password(&encoded)?),
        Err(_) => Err(first.into()),
    }
}

pub fn load_vault_key(user_id: &str) -> Result<Option<[u8; 32]>, KeychainError> {
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

pub fn forget_vault_key(user_id: &str) -> Result<(), KeychainError> {
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
    /// не сохранив, а `get_password` — всегда `NoEntry`. Ключ хранилища не
    /// сохранялся ни разу, `vault_put_blob` падал на `keychain: locked`, и
    /// **ни один секрет нельзя было записать** — при 191 зелёном тесте.
    /// Единственный тест, который бы это поймал, стоял с `#[ignore]`.
    ///
    /// Цена возврата `#[ignore]` — ровно такая же дыра, поэтому его здесь быть
    /// не должно. Если в CI тест упрётся в заблокированную связку ключей,
    /// разблокировать её в раннере, а не глушить тест.
    /// Сторож обычного пути upsert'а: повторная запись поверх существующей
    /// обязана положить НОВОЕ значение, а не упасть и не оставить старое.
    ///
    /// Честно про границы: тот отказ, ради которого `store_vault_key` переписан
    /// (запись есть, но ACL не отдаёт её на чтение), этим тестом НЕ
    /// воспроизводится и воспроизведён быть не может — ACL привязан к подписи
    /// бинарника, а тестовый бинарник подписан иначе, чем `.app`, и подделать
    /// отказ изнутри процесса нечем. Тест закрывает ровно то, что сломать легко
    /// при правке: обычную перезапись. Ветка «снести и записать заново»
    /// проверяется живым входом после перевыпуска сертификата.
    #[test]
    fn store_overwrites_existing_entry() {
        let user = "test_user_id_for_overwrite_test";
        store_vault_key(user, &[1u8; 32]).unwrap();
        store_vault_key(user, &[2u8; 32]).unwrap();
        assert_eq!(load_vault_key(user).unwrap().unwrap(), [2u8; 32]);
        forget_vault_key(user).unwrap();
        assert!(load_vault_key(user).unwrap().is_none());
    }

    #[test]
    fn keychain_roundtrip() {
        let user = "test_user_id_for_unit_tests";
        let key = [13u8; 32];
        store_vault_key(user, &key).unwrap();
        let loaded = load_vault_key(user).unwrap().unwrap();
        assert_eq!(loaded, key);
        forget_vault_key(user).unwrap();
        assert!(load_vault_key(user).unwrap().is_none());
    }
}
