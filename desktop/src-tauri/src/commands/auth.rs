use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroize;

use crate::crypto::{aead, bip39_recovery, kdf};
use crate::keychain;
use crate::sync::http::{ApiClient, ApiError};

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("kdf: {0}")]
    Kdf(String),
    #[error("aead: {0}")]
    Aead(String),
    #[error("recovery: {0}")]
    Recovery(String),
    #[error("api: {0}")]
    Api(String),
    #[error("keychain: {0}")]
    Keychain(String),
    /// Отдельно от `Aead` намеренно. Обёртка ключа хранилища ломается не так, как
    /// блоб: пароль только что прошёл аутентификацию, значит дело не в «повреждённом
    /// шифротексте», а в рассинхроне пароля и обёртки — и сказать об этом надо
    /// словами, по которым видно, что делать дальше, а не «aead: decrypt failed».
    #[error("vault key: {0}")]
    VaultKey(String),
    #[error("ssh: {0}")]
    Ssh(String),
}

impl From<crate::ssh::client::SshError> for CommandError {
    fn from(e: crate::ssh::client::SshError) -> Self {
        Self::Ssh(e.to_string())
    }
}

impl From<kdf::KdfError> for CommandError {
    fn from(e: kdf::KdfError) -> Self {
        Self::Kdf(e.to_string())
    }
}

impl From<aead::AeadError> for CommandError {
    fn from(e: aead::AeadError) -> Self {
        Self::Aead(e.to_string())
    }
}

impl From<bip39_recovery::RecoveryError> for CommandError {
    fn from(e: bip39_recovery::RecoveryError) -> Self {
        Self::Recovery(e.to_string())
    }
}

fn decode_salt16(salt_b64: &str) -> Result<[u8; 16], CommandError> {
    let bytes = B64
        .decode(salt_b64.as_bytes())
        .map_err(|_| CommandError::Kdf("invalid salt".into()))?;
    if bytes.len() != 16 {
        return Err(CommandError::Kdf("salt length".into()));
    }
    let mut a = [0u8; 16];
    a.copy_from_slice(&bytes);
    Ok(a)
}

/// Что сказать, когда обёртка не разворачивается паролем, который только что прошёл
/// аутентификацию. Перешифровать блобы этому клиенту нечем (VK он не знает), а
/// recovery-блоб оборачивает как раз VK — фраза остаётся единственной дорогой назад.
const WRAPPER_MISMATCH: &str = "Signed in, but this password does not open the vault key \
     stored for this account: the password and the stored key wrapper are out of step. \
     Use your recovery phrase to restore access.";

/// То же событие, но на развилке 409 ленивой миграции — и совет здесь ДРУГОЙ, потому
/// что положение другое. Попасть сюда можно единственным способом: между `login/finish`
/// и `vault-key/init` этому аккаунту сменили пароль (или его восстановили), и на сервере
/// теперь лежит обёртка под НОВЫМ паролем. Аккаунт цел, блобы целы, ключ найдётся сам —
/// достаточно войти новым паролем. Толкать отсюда к фразе значило бы жечь recovery там,
/// где ничего не сломано.
const WRAPPER_CHANGED_MIDFLIGHT: &str = "The account password changed while this sign-in \
     was in progress, so the stored vault key no longer matches it. Sign in again.";

/// Развернуть серверную обёртку `aead(VK, KEK)` ключом, выведенным из пароля.
///
/// `on_mismatch` — текст ровно для того случая, когда обёртка не открывается: он зависит
/// не от криптографии (она одна и та же), а от того, как мы сюда попали, см. две
/// константы выше.
fn unwrap_vault_key_with_kek(
    wrapped_b64: &str,
    kek: &[u8; aead::KEY_LEN],
    on_mismatch: &str,
) -> Result<[u8; aead::KEY_LEN], CommandError> {
    let wrapped = B64
        .decode(wrapped_b64.as_bytes())
        .map_err(|_| CommandError::VaultKey("stored key wrapper is not base64".into()))?;
    let mut plain = aead::decrypt(&wrapped, kek)
        .map_err(|_| CommandError::VaultKey(on_mismatch.to_string()))?;
    let vk: Result<[u8; aead::KEY_LEN], _> = plain.as_slice().try_into();
    // Куча под расшифровку — копия VK; гасим её до разбора результата, иначе ветка
    // «не та длина» освободит её как есть.
    plain.zeroize();
    vk.map_err(|_| {
        CommandError::VaultKey("stored key wrapper holds a key of the wrong length".into())
    })
}

/// Turn the recovery endpoints' status codes into something a user can act on.
/// 401 covers "wrong phrase" and "unknown email" alike — the backend refuses to tell
/// them apart on purpose, so neither does this message.
fn describe_recovery_error(e: ApiError) -> CommandError {
    match e {
        ApiError::Status { status: 401, .. } => CommandError::Api(
            "Recovery rejected: this phrase does not match that account. \
             Check the email address and all 24 words."
                .into(),
        ),
        ApiError::Status { status: 404, .. } | ApiError::Status { status: 409, .. } => {
            CommandError::Api(
                "This account has no recovery key configured (it predates the recovery-proof \
                 update). Sign in with your password, open Settings -> Encryption -> Recovery \
                 phrase and set recovery up again, then retry."
                    .into(),
            )
        }
        ApiError::Status { status: 429, .. } => CommandError::Api(
            "Too many recovery attempts. Wait a minute before trying again.".into(),
        ),
        other => CommandError::Api(other.to_string()),
    }
}

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
    // KEK — всё, что пароль даёт хранилищу: он оборачивает ключ, но ничего не шифрует.
    let kek = kdf::derive_master_key(password.as_bytes(), &salt)?;
    // Ключ хранилища выбирается, а не выводится. Именно поэтому смена пароля и
    // восстановление позже перепишут 72 байта обёртки и не тронут ни один блоб.
    let mut vk = aead::random_key();
    let wrapped_vk = aead::encrypt(&vk, &kek.0)?;
    let phrase = bip39_recovery::generate_phrase();
    // Фраза оборачивает VK, а не выведенный из пароля ключ: восстановление обязано
    // вернуть ровно тот ключ, которым зашифрованы блобы.
    let recovery_blob = bip39_recovery::wrap_vault_key(&vk, &phrase)?;
    let recovery_auth_key = kdf::derive_recovery_auth_key(&phrase)?;
    let resp = api
        .register(
            &email,
            &salt,
            &auth_key.0,
            &recovery_blob,
            &recovery_auth_key.0,
            &wrapped_vk,
        )
        .await;
    let resp = match resp {
        Ok(r) => r,
        // Гасим и на ошибочном пути тоже: `?` вынес бы VK со стека нетронутым, а
        // сетевой отказ — самый вероятный выход отсюда.
        Err(e) => {
            vk.zeroize();
            return Err(CommandError::Api(e.to_string()));
        }
    };
    let stored = keychain::store_vault_key(&resp.user_id, &vk);
    vk.zeroize();
    stored.map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(RegisterResult {
        user_id: resp.user_id,
        recovery_phrase: phrase,
    })
}

#[tauri::command]
pub async fn auth_login(
    email: String,
    password: String,
    totp_code: Option<String>,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let start = api
        .login_start(&email)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let salt = decode_salt16(&start.salt_b64)?;
    let auth_key = kdf::derive_auth_key(password.as_bytes(), &salt)?;
    let kek = kdf::derive_master_key(password.as_bytes(), &salt)?;
    let resp = api
        .login_finish(&email, &auth_key.0, totp_code.as_deref())
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let mut vk = match resp.wrapped_vault_key_b64.as_deref() {
        Some(wrapped) => unwrap_vault_key_with_kek(wrapped, &kek.0, WRAPPER_MISMATCH)?,
        None => adopt_vault_key(&api, &kek.0).await?,
    };
    let stored = keychain::store_vault_key(&resp.user_id, &vk);
    vk.zeroize();
    stored.map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(resp.user_id)
}

/// Ленивая миграция аккаунта, заведённого до перехода на ключ хранилища (колонка на
/// сервере пуста).
///
/// Принимаем `VK := KEK`, и это не компромисс, а единственное, что вообще возможно:
/// блобы такого аккаунта зашифрованы именно этим ключом, а recovery-блоб оборачивает
/// именно его. Перешифровывать нечего, кэш пересоздавать не нужно — не хватает ровно
/// 72 байт обёртки на сервере, и их мы и записываем.
///
/// ПОЧЕМУ ЗДЕСЬ FAIL-OPEN, А СТРОЧКОЙ ВЫШЕ (`unwrap_vault_key_with_kek` в `auth_login`)
/// FAIL-CLOSED. Разница не в аккуратности, а в том, есть ли на руках ключ.
///
/// Там обёртка ЕСТЬ и не открывается нашим KEK: правильного VK у нас нет, продолжать
/// нечем, и любой «мягкий» исход означал бы положить в связку заведомо не тот ключ.
/// Здесь обёртки нет вовсе, а VK известен точно — он равен KEK по построению аккаунта
/// до перехода. Не записать обёртку значит оставить аккаунт ровно в том состоянии, в
/// котором он и был: сервер и дальше отдаёт `null`, все клиенты и дальше выводят
/// `vk := kek`, и это ПРАВИЛЬНЫЙ ключ — блобы зашифрованы именно им. Ничего не портится
/// и ни на одном пути.
///
/// Повтор бесплатен и автоматичен: пока колонка пуста, сюда заходит каждый вход. А смена
/// пароля и восстановление закрепляют обёртку сами и безусловно — то есть даже если
/// `vault-key/init` не отработает никогда, первая же смена пароля приведёт аккаунт в
/// целевое состояние.
///
/// Цена обратного решения конкретна: десктоп — единственное, что умеет читать секреты и
/// выполнять операции. Не раскатанный бэкенд отдаёт 404 на новый эндпоинт, прокси — 502,
/// у пулера моргнул коннект — и пользователь, входивший всегда, не входит вообще, причём
/// чинить ему нечем. Незакреплённая обёртка не стоит и близко.
async fn adopt_vault_key(
    api: &ApiClient,
    kek: &[u8; aead::KEY_LEN],
) -> Result<[u8; aead::KEY_LEN], CommandError> {
    let vk = *kek;
    // Ключ шифруется сам собой (key-dependent message): `vk == kek` — это не случайность
    // и не описка, а прямое следствие правила «VK := KEK для аккаунтов до перехода».
    // Для XSalsa20-Poly1305 известных атак на такой шифротекст нет, а альтернативы —
    // выдумать новый VK — не существует: она означала бы перешифровку всех блобов.
    let wrapped = aead::encrypt(&vk, kek)?;
    match api.vault_key_init(&wrapped).await {
        Ok(()) => Ok(vk),
        // 409 — гонку выиграло другое устройство, и в колонке уже лежит ЕГО обёртка;
        // именно её будут разворачивать все следующие входы. Своя нам не нужна: до
        // перехода VK == KEK, так что обе разворачиваются в один и тот же ключ, а
        // настаивать на своей — единственный способ разойтись с остальными устройствами.
        Err(ApiError::Status { status: 409, .. }) => match api.me().await {
            Ok(me) => match me.wrapped_vault_key_b64 {
                // Единственный строгий исход во всей функции: сервер показал обёртку, и
                // она НЕ открывается нашим KEK. Значит пароль аккаунта успел смениться
                // прямо под нами, и `vk` на руках — уже не тот, которым сервер считает
                // ключ. Положить его в связку значит развести устройства; вход отклоняется.
                Some(stored) => unwrap_vault_key_with_kek(&stored, kek, WRAPPER_CHANGED_MIDFLIGHT),
                // Сервер противоречит сам себе: «уже инициализирован», а показать нечего.
                // Смотрим на это как на «обёртка не закреплена» — то есть по общему
                // правилу выше: VK у нас правильный, вход продолжается.
                None => {
                    tracing::warn!(
                        target: "auth",
                        "vault-key/init answered 409 but /auth/me reports no wrapper; \
                         signing in with the pre-migration key (vk == kek)"
                    );
                    Ok(vk)
                }
            },
            Err(e) => {
                tracing::warn!(
                    target: "auth",
                    "vault-key/init answered 409 and /auth/me is unreachable ({e}); \
                     signing in with the pre-migration key (vk == kek)"
                );
                Ok(vk)
            }
        },
        Err(e) => {
            tracing::warn!(
                target: "auth",
                "vault-key/init did not go through ({e}); signing in with the pre-migration \
                 key (vk == kek), the wrapper will be pinned on a later sign-in"
            );
            Ok(vk)
        }
    }
}

#[tauri::command]
pub async fn auth_logout(user_id: String, api: State<'_, ApiClient>) -> Result<(), CommandError> {
    api.logout().await.map_err(|e| CommandError::Api(e.to_string()))?;
    keychain::forget_vault_key(&user_id).map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(())
}

/// (Re)configure recovery for the signed-in account: mint a fresh 24-word phrase, rewrap
/// the vault key under it and register the new proof key. This is what the 409 from
/// `/auth/recovery/finish` tells legacy accounts (NULL hash, registered before migration
/// 014) to do. Requires the master password as a step-up.
///
/// Reached from Settings -> Encryption -> Recovery phrase; the caller must then show the
/// returned phrase, because the previous one stops working the moment this succeeds.
#[tauri::command]
pub async fn auth_recovery_setup(
    password: String,
    api: State<'_, ApiClient>,
) -> Result<RegisterResult, CommandError> {
    let me = api.me().await.map_err(|e| CommandError::Api(e.to_string()))?;
    let start = api
        .login_start(&me.email)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let salt = decode_salt16(&start.salt_b64)?;
    let auth_key = kdf::derive_auth_key(password.as_bytes(), &salt)?;
    let phrase = bip39_recovery::generate_phrase();
    // Оборачиваем ключ ИЗ СВЯЗКИ, а не выведенный из пароля: фраза обязана открывать
    // ровно тот ключ, которым зашифрованы блобы. Пароль здесь остался step-up'ом
    // (проверяется сервером через `auth_key`) и ключом хранилища больше не является.
    //
    // Читаем его после обоих сетевых вызовов и гасим до третьего: так копия VK не живёт
    // на стеке ни через один `await` — а с ними это были бы секунды при живой сети и до
    // тридцати при таймауте.
    let mut vk = keychain::load_vault_key(&me.id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let recovery_blob = bip39_recovery::wrap_vault_key(&vk, &phrase);
    vk.zeroize();
    let recovery_blob = recovery_blob?;
    let recovery_auth_key = kdf::derive_recovery_auth_key(&phrase)?;
    api.recovery_setup(&auth_key.0, &recovery_blob, &recovery_auth_key.0)
        .await
        .map_err(|e| match e {
            ApiError::Status { status: 401, .. } => {
                CommandError::Api("Wrong master password — recovery was not changed.".into())
            }
            other => CommandError::Api(other.to_string()),
        })?;
    Ok(RegisterResult {
        user_id: me.id,
        recovery_phrase: phrase,
    })
}

/// Может ли аккаунт вообще восстановиться. `None` — сервер не ответил на этот вопрос
/// (поле появилось вместе с миграцией 014), и тогда UI молчит вместо того, чтобы гадать.
#[tauri::command]
pub async fn auth_recovery_status(api: State<'_, ApiClient>) -> Result<Option<bool>, CommandError> {
    let me = api.me().await.map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(me.recovery_configured)
}

/// Всё, что восстановление считает из фразы и нового пароля, — одной чистой функцией:
/// VK (тот же, что и до восстановления), его обёртка под новым паролем и recovery-блоб.
///
/// Вынесено из `auth_recovery` по той же причине, что и `put_blob_encrypted` из
/// `vault_put_blob`: команда приварена к keychain и `State<ApiClient>`, а держится
/// здесь ровно тот инвариант, ради которого всё затевалось, — ключ, уезжающий в связку,
/// обязан быть тем самым, которым зашифрованы уже лежащие блобы. Пока эти четыре
/// строки жили внутри команды, подмена VK на «ключ из нового пароля» (тот самый дефект,
/// который чинится) не роняла ни одного теста, а стоила владельцу всех его секретов.
///
/// Фраза не меняется, поэтому новый recovery-блоб по смыслу равен старому — но он
/// перевыпускается, а не переиспользуется: сервер ждёт блоб в теле запроса, и слать
/// туда прочитанные оттуда же байты значило бы делать вид, что мы их не разбирали.
fn recovery_payload(
    recovery_blob: &[u8],
    phrase: &str,
    new_password: &str,
    new_salt: &[u8; 16],
) -> Result<([u8; aead::KEY_LEN], Vec<u8>, Vec<u8>), CommandError> {
    // Из блоба выходит ключ ХРАНИЛИЩА, а не пароль и не выведенный из него ключ.
    let mut vk = bip39_recovery::unwrap_vault_key(recovery_blob, phrase)?;
    // Всё, что делается с VK, живёт между этими двумя строками. `[u8; 32]` — `Copy`:
    // результат унесёт копию, а эта осталась бы на стеке, поэтому гасим её в любом
    // случае, включая ошибочный путь.
    let out: Result<([u8; aead::KEY_LEN], Vec<u8>, Vec<u8>), CommandError> = (|| {
        let new_kek = kdf::derive_master_key(new_password.as_bytes(), new_salt)?;
        let new_wrapped_vk = aead::encrypt(&vk, &new_kek.0)?;
        let new_recovery_blob = bip39_recovery::wrap_vault_key(&vk, phrase)?;
        Ok((vk, new_wrapped_vk, new_recovery_blob))
    })();
    vk.zeroize();
    out
}

#[tauri::command]
pub async fn auth_recovery(
    email: String,
    phrase: String,
    new_password: String,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let start = api
        .recovery_start(&email)
        .await
        .map_err(describe_recovery_error)?;
    let recovery_bytes = B64
        .decode(start.recovery_blob_b64.as_bytes())
        .map_err(|_| CommandError::Recovery("recovery blob".into()))?;
    let new_salt = kdf::random_salt();
    let (mut vk, new_wrapped_vk, new_recovery) =
        recovery_payload(&recovery_bytes, &phrase, &new_password, &new_salt)?;
    let recovery_auth_key = kdf::derive_recovery_auth_key(&phrase)?;
    let new_auth = kdf::derive_auth_key(new_password.as_bytes(), &new_salt)?;
    // The phrase is unchanged, so the stored hash must stay as it is: rotating it here
    // to a key derived from the same phrase would be a no-op at best.
    let resp = api
        .recovery_finish(
            &email,
            &recovery_auth_key.0,
            &new_salt,
            &new_auth.0,
            &new_recovery,
            &new_wrapped_vk,
            None,
        )
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            vk.zeroize();
            return Err(describe_recovery_error(e));
        }
    };
    let uid = match resp.user_id {
        Some(uid) => uid,
        None => {
            vk.zeroize();
            return Err(CommandError::Api("recovery response missing user_id".into()));
        }
    };
    // Тот же VK, что и до восстановления: блобы остались как лежали, и открывать их
    // теперь есть чем.
    let stored = keychain::store_vault_key(&uid, &vk);
    vk.zeroize();
    stored.map_err(|e| CommandError::Keychain(e.to_string()))?;
    Ok(uid)
}

/// Всё, что смена пароля считает из нового пароля, — одной чистой функцией, симметрично
/// `recovery_payload`: хеш-ключ аутентификации и обёртка VK под новым паролем.
///
/// Инвариант здесь тот же и цена ошибки та же: **оба** значения обязаны выводиться из
/// НОВОЙ соли. Опечатка в один символ — `&salt` вместо `&new_salt` при выводе KEK —
/// оставила бы на сервере обёртку, которую новый пароль не разворачивает, то есть ровно
/// тот локаут, ради которого всё это и затевалось. Пока арифметика жила внутри команды,
/// поймать её было нечем: команда приварена к keychain и `State<ApiClient>`, а
/// http-тест проверяет только форму тела и на подменённые байты согласится.
///
/// Функция берёт одну-единственную соль, поэтому старая внутрь просто не попадает —
/// подменить нечего; тест ниже держит вторую половину свойства, что обёртка
/// открывается KEK'ом именно из этой пары (пароль, соль).
fn password_change_payload(
    vk: &[u8; aead::KEY_LEN],
    new_password: &str,
    new_salt: &[u8; 16],
) -> Result<(kdf::DerivedKey, Vec<u8>), CommandError> {
    let new_auth = kdf::derive_auth_key(new_password.as_bytes(), new_salt)?;
    let new_kek = kdf::derive_master_key(new_password.as_bytes(), new_salt)?;
    let new_wrapped_vk = aead::encrypt(vk, &new_kek.0)?;
    Ok((new_auth, new_wrapped_vk))
}

/// Сменить пароль. Блобы и локальный кэш не трогаются вовсе — в этом весь смысл VK:
/// секреты зашифрованы им, а пароль его только оборачивает, так что на сервере
/// переписываются соль, хеш auth-ключа и 72 байта обёртки, и больше ничего.
///
/// Старый пароль проверяет сервер (`old_auth_key` против хранимого хеша) — 401 значит
/// «пароль не тот», и до мутаций дело не доходит.
#[tauri::command]
pub async fn auth_change_password(
    old_password: String,
    new_password: String,
    api: State<'_, ApiClient>,
) -> Result<(), CommandError> {
    let me = api.me().await.map_err(|e| CommandError::Api(e.to_string()))?;
    let start = api
        .login_start(&me.email)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let salt = decode_salt16(&start.salt_b64)?;
    let old_auth = kdf::derive_auth_key(old_password.as_bytes(), &salt)?;
    let new_salt = kdf::random_salt();
    // VK читается после обоих сетевых вызовов и гасится до третьего: копия ключа не
    // переживает ни одного `await`, а с прежним порядком их было два — секунды при
    // живой сети и до тридцати при таймауте.
    let mut vk = keychain::load_vault_key(&me.id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let payload = password_change_payload(&vk, &new_password, &new_salt);
    vk.zeroize();
    let (new_auth, new_wrapped_vk) = payload?;
    api.password_change(&old_auth.0, &new_salt, &new_auth.0, &new_wrapped_vk)
        .await
        .map_err(|e| match e {
            ApiError::Status { status: 401, .. } => {
                CommandError::Api("Wrong current password — the password was not changed.".into())
            }
            other => CommandError::Api(other.to_string()),
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Ответ `/auth/me` — ровно то, что от него нужно ленивой миграции.
    fn me_body(wrapped_vault_key_b64: Option<&str>) -> serde_json::Value {
        json!({
            "id": "u-1",
            "email": "a@b.c",
            "wrapped_vault_key_b64": wrapped_vault_key_b64,
        })
    }

    /// ГЛАВНЫЙ инвариант этой правки, и ровно тот, которого не было: блоб,
    /// зашифрованный ДО восстановления, открывается ключом из связки ПОСЛЕ него.
    ///
    /// Раньше восстановление поворачивало и соль, и пароль, а в связку клало ключ,
    /// выведенный из них, — математически не тот, которым сделаны шифротексты.
    /// Ни один тест этого не ловил, потому что ни один не пробовал открыть старый
    /// блоб новым ключом: все проверяли форму запросов.
    #[test]
    fn a_blob_encrypted_before_recovery_opens_with_the_key_stored_after_it() {
        // --- Аккаунт до восстановления: VK, блоб под ним, фраза поверх VK. ---
        let vk = aead::random_key();
        let secret = b"correct horse battery staple";
        let blob = aead::encrypt(secret, &vk).unwrap();
        let phrase = bip39_recovery::generate_phrase();
        let recovery_blob = bip39_recovery::wrap_vault_key(&vk, &phrase).unwrap();

        // --- Восстановление с совершенно новым паролем и новой солью. ---
        let new_salt = kdf::random_salt();
        let (vk_after, new_wrapped_vk, new_recovery_blob) =
            recovery_payload(&recovery_blob, &phrase, "a brand new password", &new_salt).unwrap();

        // Вот он: старый шифротекст, ключ из связки после восстановления.
        assert_eq!(aead::decrypt(&blob, &vk_after).unwrap(), secret);

        // И то, из-за чего это работает: в связку уехал ТОТ ЖЕ ключ, а не выведенный
        // из нового пароля. Сравнение с KEK — сторож против «починки» вида
        // `vk_after = new_kek`: с ней ассерт выше остался бы зелёным только если бы
        // блоб перешифровали, а перешифровки нет и не будет.
        let new_kek = kdf::derive_master_key(b"a brand new password", &new_salt).unwrap();
        assert_eq!(vk_after, vk);
        assert_ne!(vk_after, new_kek.0);

        // Обёртка, уезжающая на сервер, разворачивается новым паролем в тот же VK:
        // без этого следующий вход остался бы без ключа.
        assert_eq!(
            new_wrapped_vk.len(),
            aead::NONCE_LEN + aead::TAG_LEN + aead::KEY_LEN,
            "сервер принимает ровно 72 байта"
        );
        assert_eq!(aead::decrypt(&new_wrapped_vk, &new_kek.0).unwrap(), vk);

        // А фраза — прежняя, и открывает она по-прежнему VK.
        assert_eq!(
            bip39_recovery::unwrap_vault_key(&new_recovery_blob, &phrase).unwrap(),
            vk
        );
    }

    /// Чужая фраза не должна давать «какой-нибудь» ключ: тихо разошедшийся VK хуже
    /// отказа — он молча положит в связку мусор и убьёт доступ к блобам.
    #[test]
    fn recovery_payload_rejects_a_phrase_that_does_not_open_the_blob() {
        let vk = aead::random_key();
        let phrase = bip39_recovery::generate_phrase();
        let blob = bip39_recovery::wrap_vault_key(&vk, &phrase).unwrap();
        let other = bip39_recovery::generate_phrase();
        let salt = kdf::random_salt();
        assert!(matches!(
            recovery_payload(&blob, &other, "pw", &salt),
            Err(CommandError::Recovery(_))
        ));
    }

    /// Рассинхрон пароля и обёртки обязан звучать по-человечески. `aead: decrypt
    /// failed: tag mismatch or corrupted ciphertext` на экране входа не говорит ни что
    /// случилось, ни что делать, — а сделать тут можно ровно одно: восстановиться по
    /// фразе.
    #[test]
    fn a_wrapper_that_the_password_does_not_open_says_what_to_do() {
        let vk = aead::random_key();
        let wrapped = B64.encode(aead::encrypt(&vk, &[1u8; aead::KEY_LEN]).unwrap());
        let err = unwrap_vault_key_with_kek(&wrapped, &[2u8; aead::KEY_LEN], WRAPPER_MISMATCH)
            .unwrap_err();
        let text = err.to_string();
        assert!(matches!(err, CommandError::VaultKey(_)), "{text}");
        assert!(text.contains("recovery phrase"), "{text}");
    }

    /// А вот на развилке 409 совет обязан быть другим: там VK правильный и аккаунт цел,
    /// жечь фразу не из-за чего. Совет, толкающий к восстановлению там, где хватает
    /// повторного входа, дороже невнятного текста.
    #[test]
    fn a_wrapper_rewritten_mid_sign_in_tells_the_user_to_sign_in_again() {
        let vk = aead::random_key();
        let wrapped = B64.encode(aead::encrypt(&vk, &[1u8; aead::KEY_LEN]).unwrap());
        let err =
            unwrap_vault_key_with_kek(&wrapped, &[2u8; aead::KEY_LEN], WRAPPER_CHANGED_MIDFLIGHT)
                .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("Sign in again"), "{text}");
        assert!(!text.contains("recovery phrase"), "{text}");
    }

    #[test]
    fn unwrap_vault_key_roundtrips_a_wrapper_made_by_the_same_key() {
        let vk = aead::random_key();
        let kek = [5u8; aead::KEY_LEN];
        let wrapped = B64.encode(aead::encrypt(&vk, &kek).unwrap());
        assert_eq!(
            unwrap_vault_key_with_kek(&wrapped, &kek, WRAPPER_MISMATCH).unwrap(),
            vk
        );
    }

    /// Зеркало теста восстановления, и по той же причине: обёртка, уезжающая на сервер
    /// при смене пароля, обязана разворачиваться KEK'ом из НОВОГО пароля и НОВОЙ соли
    /// в ТОТ ЖЕ VK. Ошибись здесь солью — и владелец не войдёт новым паролем, то есть
    /// получит ровно тот локаут, который эта правка чинит.
    #[test]
    fn the_wrapper_a_password_change_uploads_opens_with_the_new_password() {
        let vk = aead::random_key();
        let secret = b"an ssh password that must survive a password change";
        let blob = aead::encrypt(secret, &vk).unwrap();

        // Соль ДО смены пароля. Держится в тесте нарочно: это тот самый `&salt`,
        // подмена на который и есть опечатка в один символ.
        let salt = kdf::random_salt();
        let new_salt = kdf::random_salt();
        let (new_auth, new_wrapped_vk) =
            password_change_payload(&vk, "the new password", &new_salt).unwrap();

        // Обёртка открывается парой (новый пароль, новая соль) — и даёт тот же VK,
        // которым зашифрован блоб, лежащий на сервере с прошлой недели.
        let new_kek = kdf::derive_master_key(b"the new password", &new_salt).unwrap();
        let unwrapped = aead::decrypt(&new_wrapped_vk, &new_kek.0).unwrap();
        assert_eq!(unwrapped, vk);
        assert_eq!(aead::decrypt(&blob, &vk).unwrap(), secret);
        assert_eq!(
            new_wrapped_vk.len(),
            aead::NONCE_LEN + aead::TAG_LEN + aead::KEY_LEN,
            "сервер принимает ровно 72 байта"
        );

        // И то, что ловит опечатку: под СТАРОЙ солью тот же пароль даёт другой KEK,
        // и обёртка им не открывается. Выведи её из `&salt` — этот ассерт станет
        // единственным зелёным, а предыдущий покраснеет.
        let kek_under_old_salt = kdf::derive_master_key(b"the new password", &salt).unwrap();
        assert!(aead::decrypt(&new_wrapped_vk, &kek_under_old_salt.0).is_err());

        // Хеш-ключ аутентификации выводится из той же новой пары: сервер сохранит
        // `new_salt`, и следующий `login/start` отдаст именно её.
        assert_eq!(
            new_auth.0,
            kdf::derive_auth_key(b"the new password", &new_salt).unwrap().0
        );
        assert_ne!(
            new_auth.0,
            kdf::derive_auth_key(b"the new password", &salt).unwrap().0
        );
    }

    // --- Ленивая миграция аккаунта до перехода. Самая новая и самая ветвистая логика
    // правки; `adopt_vault_key` берёт `&ApiClient`, а не `State`, ровно чтобы её можно
    // было проверить тем же wiremock, что и весь `sync/http.rs`. ---

    /// Счастливый путь: обёртка уезжает на сервер, а ключом остаётся KEK — им и
    /// зашифрованы блобы этого аккаунта. Проверяется не только возвращённое значение,
    /// но и то, что реально ушло в теле: обёртка обязана разворачиваться тем же KEK.
    #[tokio::test]
    async fn adopt_vault_key_pins_the_wrapper_and_keeps_the_pre_migration_key() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/vault-key/init"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
            .expect(1)
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let kek = [7u8; aead::KEY_LEN];
        let vk = adopt_vault_key(&c, &kek).await.unwrap();
        assert_eq!(vk, kek, "до перехода VK == KEK, иначе блобы не откроются");

        let reqs = srv.received_requests().await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        let wrapped = B64
            .decode(body["wrapped_vault_key_b64"].as_str().unwrap())
            .unwrap();
        assert_eq!(wrapped.len(), aead::NONCE_LEN + aead::TAG_LEN + aead::KEY_LEN);
        assert_eq!(aead::decrypt(&wrapped, &kek).unwrap(), vk);
    }

    /// Гонку выиграло другое устройство: 409 → перечитать `/auth/me` → развернуть ЧУЖУЮ
    /// обёртку. Ключ обязан выйти тот же самый — обёртки различаются только nonce'ом,
    /// потому что до перехода оба устройства выводят один KEK и принимают `VK := KEK`.
    #[tokio::test]
    async fn adopt_vault_key_resolves_a_lost_race_into_the_very_same_key() {
        let srv = MockServer::start().await;
        let kek = [9u8; aead::KEY_LEN];
        let theirs = aead::encrypt(&kek, &kek).unwrap();
        Mock::given(method("POST"))
            .and(path("/api/auth/vault-key/init"))
            .respond_with(
                ResponseTemplate::new(409)
                    .set_body_json(json!({"detail": "vault key already initialized"})),
            )
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/auth/me"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(me_body(Some(&B64.encode(&theirs)))),
            )
            .expect(1)
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let vk = adopt_vault_key(&c, &kek).await.unwrap();
        assert_eq!(vk, kek);

        // Наша собственная обёртка ушла на сервер и была отвергнута — и она байт в байт
        // не равна чужой (свежий nonce на каждый `encrypt`). Ровно поэтому сравнение
        // байтов на сервере и даёт 409, а не 200: «идемпотентный повтор теми же байтами»
        // из этого клиента недостижим. Ключ при этом получается один и тот же.
        let reqs = srv.received_requests().await.unwrap();
        let sent: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        let ours = B64
            .decode(sent["wrapped_vault_key_b64"].as_str().unwrap())
            .unwrap();
        assert_ne!(ours, theirs);
        assert_eq!(aead::decrypt(&ours, &kek).unwrap(), vk);
    }

    /// Единственный строгий исход ленивой миграции: сервер показал обёртку, и она НЕ
    /// открывается нашим KEK. Значит пароль сменили прямо под нами, ключ на руках уже
    /// не тот, и вход отклоняется — но советом «войдите ещё раз», а не «жгите фразу».
    #[tokio::test]
    async fn adopt_vault_key_refuses_a_wrapper_it_cannot_open() {
        let srv = MockServer::start().await;
        let kek = [9u8; aead::KEY_LEN];
        let alien = aead::encrypt(&[1u8; aead::KEY_LEN], &[2u8; aead::KEY_LEN]).unwrap();
        Mock::given(method("POST"))
            .and(path("/api/auth/vault-key/init"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({"detail": "conflict"})))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/auth/me"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(me_body(Some(&B64.encode(&alien)))),
            )
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let err = adopt_vault_key(&c, &kek).await.unwrap_err();
        let text = err.to_string();
        assert!(matches!(err, CommandError::VaultKey(_)), "{text}");
        assert!(text.contains("Sign in again"), "{text}");
    }

    /// FAIL-OPEN, и это главное свойство ветки. Незакреплённая обёртка не портит ничего:
    /// сервер и дальше отдаёт `null`, все клиенты и дальше выводят `vk := kek`, а
    /// повтор случится сам на следующем входе. Уронить же вход означает оставить
    /// пользователя без единственного, что умеет читать секреты, — из-за не
    /// раскатанного бэкенда (404), прокси (502) или моргнувшего коннекта.
    #[tokio::test]
    async fn a_vault_key_init_that_does_not_go_through_still_signs_the_user_in() {
        let kek = [3u8; aead::KEY_LEN];
        for status in [404u16, 500, 502, 503] {
            let srv = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/api/auth/vault-key/init"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&srv)
                .await;
            let c = ApiClient::new(format!("{}/api", srv.uri()));
            assert_eq!(adopt_vault_key(&c, &kek).await.unwrap(), kek, "{status}");
        }

        // И транспортный отказ — сервера нет вовсе, коннект отклонён.
        let c = ApiClient::new("http://127.0.0.1:1/api".to_string());
        assert_eq!(adopt_vault_key(&c, &kek).await.unwrap(), kek);
    }

    /// 409 получен, а `/auth/me` не ответил: чужую обёртку сравнить не с чем, но VK на
    /// руках заведомо правильный (`VK := KEK`), и это та же ситуация, что выше. Отказ
    /// во входе здесь был бы наказанием за сетевую икоту.
    #[tokio::test]
    async fn a_lost_race_with_an_unreachable_me_still_signs_the_user_in() {
        let srv = MockServer::start().await;
        let kek = [4u8; aead::KEY_LEN];
        Mock::given(method("POST"))
            .and(path("/api/auth/vault-key/init"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({"detail": "conflict"})))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/auth/me"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        assert_eq!(adopt_vault_key(&c, &kek).await.unwrap(), kek);
    }

    /// Сервер противоречит сам себе: «уже инициализирован», а показать нечего. Читаем
    /// это как «обёртка не закреплена» — то есть по общему правилу, а не отказом.
    #[tokio::test]
    async fn a_lost_race_with_a_server_that_reports_no_wrapper_still_signs_the_user_in() {
        let srv = MockServer::start().await;
        let kek = [5u8; aead::KEY_LEN];
        Mock::given(method("POST"))
            .and(path("/api/auth/vault-key/init"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({"detail": "conflict"})))
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/auth/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(me_body(None)))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        assert_eq!(adopt_vault_key(&c, &kek).await.unwrap(), kek);
    }
}
