//! Общие helper'ы для Tauri-команд: расшифровка blob'ов, доступ к локальному
//! кэшу и best-effort запись в audit log.

use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{AppHandle, Emitter, State};

use crate::commands::auth::CommandError;
use crate::commands::sync_cmd::SyncHandle;
use crate::crypto::aead;
use crate::sync::http::ApiClient;

/// Забрать зашифрованный blob по id и расшифровать его ключом хранилища (VK).
pub(crate) async fn blob_plaintext(
    api: &ApiClient,
    key: &[u8; 32],
    blob_id: &str,
) -> Result<Vec<u8>, CommandError> {
    let blob = api
        .blob_get(blob_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let raw = B64
        .decode(blob.ciphertext_b64.as_bytes())
        .map_err(|_| CommandError::Aead("b64".into()))?;
    aead::decrypt(&raw, key).map_err(|e| CommandError::Aead(e.to_string()))
}

pub(crate) fn json_str(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(|s| s.to_string())
}

pub(crate) fn json_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_u64().map(|u| u as i64))
}

/// Канал событий для действий, чей аудит не удалось записать.
///
/// Отдельный от `provision:progress`/`fastpanel:progress` канал: те привязаны к
/// длинной операции с шагами, а cf/registrar — одиночные мутации, и слушателю
/// нужен один общий подписчик на все из них.
pub(crate) const AUDIT_PROGRESS_EVENT: &str = "audit:progress";

/// Записать действие в audit log, не роняя саму команду.
///
/// Мутация к этому моменту уже выполнена на стороне Cloudflare/регистратора и
/// откату не подлежит. Фатальный аудит (`?`) на сетевом сбое последнего шага
/// превращал бы успешную операцию в `Err`: пользователь повторял бы её (для
/// delete — уже по несуществующей записи, то есть в 404), а записи в аудите всё
/// равно бы не появилось. «Фатально» не даёт никакой гарантии и стоит
/// корректности — НЕ превращать обратно в `?`.
///
/// Но best-effort не значит «молча»: помимо варнинга в лог шлём событие, по
/// которому фронт покажет, что действие осталось незаписанным.
pub(crate) async fn audit_best_effort(
    app: &AppHandle,
    api: &ApiClient,
    action: &str,
    target_type: &str,
    target_id: &str,
    device_id: Option<uuid::Uuid>,
    metadata: Option<serde_json::Value>,
) {
    if let Err(e) = api
        .audit_log(
            action,
            Some(target_type),
            Some(target_id),
            device_id,
            metadata,
        )
        .await
    {
        tracing::warn!(target: "audit", "audit log for {action} failed: {e}");
        let _ = app.emit(
            AUDIT_PROGRESS_EVENT,
            serde_json::json!({
                "step": "audit_failed",
                "action": action,
                "target_type": target_type,
                "target_id": target_id,
            }),
        );
    }
}

/// Путь к локальному кэшу из инициализированного `SyncHandle`.
pub(crate) fn cache_path(handle: &State<'_, SyncHandle>) -> Result<PathBuf, CommandError> {
    let g = handle.0.lock().map_err(|e| CommandError::Api(e.to_string()))?;
    let c = g
        .as_ref()
        .ok_or_else(|| CommandError::Api("sync not initialized".into()))?;
    Ok(c.cache_path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Отдать блоб так, как его отдаёт бэкенд (`app/blobs/routes.py::_to_response`).
    async fn serve_blob(srv: &MockServer, blob_id: &str, ciphertext: &[u8]) {
        Mock::given(method("GET"))
            .and(path(format!("/api/blobs/{blob_id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": blob_id,
                "blob_kind": "ssh_password",
                "ciphertext_b64": B64.encode(ciphertext),
                "version": 7,
                "updated_at": "2026-08-04T00:00:00Z",
                "deleted": false,
            })))
            .mount(srv)
            .await;
    }

    /// Замыкание всей цепочки спринта: то, что уехало на сервер шифротекстом,
    /// возвращается провижинингу исходным паролем.
    ///
    /// Именно этой функцией `provision.rs` достаёт SSH-пароль. Если она начнёт
    /// отдавать сырые байты блоба, десктоп пойдёт логиниться base64-мусором, а
    /// пользователь увидит невнятное «auth failed» вместо понятной причины.
    #[tokio::test]
    async fn blob_plaintext_returns_the_password_that_was_encrypted() {
        let srv = MockServer::start().await;
        let key = [77u8; aead::KEY_LEN];
        let password = "correct horse battery staple";
        serve_blob(&srv, "b-9", &aead::encrypt(password.as_bytes(), &key).unwrap()).await;

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        let got = blob_plaintext(&api, &key, "b-9").await.unwrap();
        assert_eq!(String::from_utf8(got).unwrap(), password);
    }

    /// Чужой ключ должен давать ошибку, а не «какой-нибудь» пароль: молчаливый
    /// мусор в ответе означал бы, что расшифровка не проверяется вовсе.
    #[tokio::test]
    async fn blob_plaintext_fails_on_a_foreign_key() {
        let srv = MockServer::start().await;
        serve_blob(
            &srv,
            "b-9",
            &aead::encrypt(b"secret", &[77u8; aead::KEY_LEN]).unwrap(),
        )
        .await;

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        // `Aead` прилетает и с провала base64 (см. выше по функции), но мок
        // отдаёт заведомо валидный b64 — значит, причина именно в ключе.
        let err = blob_plaintext(&api, &[1u8; aead::KEY_LEN], "b-9")
            .await
            .unwrap_err();
        assert!(matches!(err, CommandError::Aead(_)), "{err}");
    }
}
