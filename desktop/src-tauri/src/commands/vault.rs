use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::State;

use crate::commands::auth::CommandError;
use crate::crypto::aead;
use crate::keychain;
use crate::sync::http::ApiClient;

#[tauri::command]
pub async fn vault_decrypt_blob(
    user_id: String,
    blob_id: String,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let blob = api
        .blob_get(&blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let raw = B64
        .decode(blob.ciphertext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    let plaintext = aead::decrypt(&raw, &key)?;
    Ok(B64.encode(&plaintext))
}

/// Зашифровать секрет и отправить его блобом — единственное место, где
/// плейнтекст становится шифротекстом перед выходом с машины.
///
/// Вынесено из `vault_put_blob` ровно затем, чтобы этот шаг можно было
/// проверить тестом: сама команда приварена к keychain и `State<ApiClient>`, и
/// пока связка `encrypt` → `blob_put` жила внутри неё, замена шифрования на
/// `pt.clone()` не роняла ни одного теста — то есть SSH-пароли всех
/// пользователей могли уехать на сервер плейнтекстом при зелёном наборе.
async fn put_blob_encrypted(
    api: &ApiClient,
    key: &[u8; 32],
    blob_id: &str,
    blob_kind: &str,
    plaintext: &[u8],
) -> Result<(), CommandError> {
    let ct = aead::encrypt(plaintext, key)?;
    api.blob_put(blob_id, blob_kind, &ct)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
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
    let pt = B64
        .decode(plaintext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    put_blob_encrypted(&api, &key, &blob_id, &blob_kind, &pt).await
}

#[tauri::command]
pub async fn vault_delete_blob(blob_id: String, api: State<'_, ApiClient>) -> Result<(), CommandError> {
    api.blob_delete(&blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Инвариант zero-knowledge, записанный как тест: на входе плейнтекст, на
    /// проводе — шифротекст, и развернуть его может только держатель ключа.
    ///
    /// Смотрим не на форму вызова, а на то, что реально легло в тело запроса:
    /// вытаскиваем body из `wiremock`, декодируем base64 и разбираем байты.
    /// Тест вида «`blob_put` вызвался» остался бы зелёным и в мире, где в
    /// `ciphertext_b64` уехал пароль открытым текстом, — а после этой ошибки
    /// сервер видит секреты всех пользователей.
    #[tokio::test]
    async fn put_blob_encrypted_puts_ciphertext_on_the_wire_and_only_the_key_undoes_it() {
        let srv = MockServer::start().await;
        // Тело ответа пустое намеренно: `blob_put` уходит в `expect_ok`, а тот
        // читает только статус. Нарисованный тут блоб ничего бы не проверял.
        Mock::given(method("PUT"))
            .and(path("/api/blobs/b-1"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&srv)
            .await;

        let key = [42u8; aead::KEY_LEN];
        let plaintext = b"correct horse battery staple";

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        put_blob_encrypted(&api, &key, "b-1", "ssh_password", plaintext)
            .await
            .unwrap();

        let reqs = srv.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        let body: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        assert_eq!(body["blob_kind"], "ssh_password");
        let wire = B64
            .decode(body["ciphertext_b64"].as_str().unwrap())
            .expect("ciphertext_b64 must be base64");

        assert!(
            !wire.windows(plaintext.len()).any(|w| w == plaintext),
            "плейнтекст найден в теле запроса"
        );
        // Длина ровно «плейнтекст + обвязка»: сойдись она с длиной плейнтекста
        // — шифрования не было; разойдись с обвязкой — раскладка уехала, и
        // десктоп не расшифрует то, что сам же и прислал.
        assert_eq!(wire.len(), plaintext.len() + aead::NONCE_LEN + aead::TAG_LEN);
        assert_eq!(aead::decrypt(&wire, &key).unwrap(), plaintext);
        // Именно `Decrypt`, а не любая ошибка: на `TooShort` этот ассерт был
        // бы зелёным при поехавшей раскладке — то есть по неверной причине.
        assert!(matches!(
            aead::decrypt(&wire, &[1u8; aead::KEY_LEN]),
            Err(aead::AeadError::Decrypt)
        ));
    }
}
