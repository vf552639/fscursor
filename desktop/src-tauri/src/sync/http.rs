use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::{cookie::Jar, Client, ClientBuilder};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone)]
pub struct ApiClient {
    pub base_url: String,
    pub http: Client,
    pub jar: Arc<Jar>,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("api error {status}: {body}")]
    Status { status: u16, body: String },
    /// Тело не отправлено: в нём нашлось поле с секретоподобным именем. Не
    /// сетевая ошибка, а сработавший инвариант zero-knowledge.
    #[error("refusing to send a body with the field {0}")]
    Secret(String),
}

#[derive(Debug, Deserialize)]
pub struct RegisterResponse {
    pub user_id: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginStartResponse {
    pub salt_b64: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginFinishResponse {
    pub user_id: String,
    /// `aead(VK, KEK)`, 72 байта в base64. `None` — аккаунт заведён до перехода на
    /// ключ хранилища: у него VK == KEK, и обёртку клиенту предстоит проставить
    /// самому через `/auth/vault-key/init`. `serde(default)` тут не удобство, а
    /// та же ветка: сервер отдаёт `null` явно, но старый бэкенд поля не пришлёт
    /// вовсе, и оба случая означают ровно одно.
    #[serde(default)]
    pub wrapped_vault_key_b64: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RecoveryStartResponse {
    pub salt_b64: String,
    pub recovery_blob_b64: String,
}

#[derive(Debug, Deserialize)]
pub struct RecoveryFinishResponse {
    pub ok: bool,
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UserMeResponse {
    pub id: String,
    pub email: String,
    /// `None` — сервер поля не прислал (бэкенд старше миграции 014). Это «не знаю»,
    /// а не «не настроено»: UI в таком случае не утверждает ничего, потому что
    /// ложное «не настроено» толкает пользователя перевыпустить фразу и обесценить
    /// ту, что уже записана на бумаге.
    #[serde(default)]
    pub recovery_configured: Option<bool>,
    /// Та же обёртка, что и в `LoginFinishResponse`. Нужна ровно на одной развилке:
    /// `/auth/vault-key/init` ответил 409, гонку выиграло другое устройство, и
    /// правильная обёртка теперь та, что лежит на сервере, а не своя.
    #[serde(default)]
    pub wrapped_vault_key_b64: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ChangeRow {
    pub table: String,
    pub id: String,
    pub version: u64,
    pub deleted: bool,
    pub fields: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct SyncChangesResponse {
    pub version: u64,
    pub rows: Vec<ChangeRow>,
    pub blob_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct BlobPayload {
    pub id: String,
    pub blob_kind: String,
    pub ciphertext_b64: String,
    pub version: i64,
    pub updated_at: String,
    pub deleted: bool,
}

#[derive(Debug, Serialize)]
struct RegisterBody<'a> {
    email: &'a str,
    salt_b64: String,
    auth_key_b64: String,
    recovery_blob_b64: String,
    /// Argon2id(phrase, salt=b"sdmp-recovery-v1", ctx="sdmp-recovery-key-v1"); required.
    recovery_auth_key_b64: String,
    /// `aead(VK, KEK)`; required. A new account is born with a vault key — NULL in that
    /// column means something else entirely ("registered before the migration").
    wrapped_vault_key_b64: String,
}

#[derive(Debug, Serialize)]
struct LoginStartBody<'a> {
    email: &'a str,
}

#[derive(Debug, Serialize)]
struct LoginFinishBody<'a> {
    email: &'a str,
    auth_key_b64: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    totp_code: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct RecoveryFinishBody<'a> {
    email: &'a str,
    /// Proof of phrase ownership. Wrong key (or unknown email) => 401.
    recovery_auth_key_b64: String,
    new_salt_b64: String,
    new_auth_key_b64: String,
    new_recovery_blob_b64: String,
    /// The unchanged VK, rewrapped under the new password's KEK. Required: without it
    /// the rotated salt and password would cut the owner off from their own blobs.
    new_wrapped_vault_key_b64: String,
    /// Only when recovery issued a NEW phrase; null keeps the stored hash. Sending the
    /// wrong thing here (or nothing, after a rotation) makes the account unrecoverable.
    new_recovery_auth_key_b64: Option<String>,
}

#[derive(Debug, Serialize)]
struct VaultKeyInitBody {
    wrapped_vault_key_b64: String,
}

#[derive(Debug, Serialize)]
struct ChangePasswordBody {
    /// Step-up: the server verifies this against the stored hash, so a stolen cookie
    /// alone cannot rotate the password.
    old_auth_key_b64: String,
    new_salt_b64: String,
    new_auth_key_b64: String,
    /// The same VK as before, wrapped under the new password. There is no
    /// `re_encrypted_blobs` field any more, and no re-encryption behind it: blobs are
    /// keyed by the VK, and the VK is what a password change deliberately leaves alone.
    new_wrapped_vault_key_b64: String,
}

#[derive(Debug, Serialize)]
struct RecoverySetupBody {
    /// Current password's auth key — step-up so a stolen cookie alone cannot
    /// overwrite the recovery blob.
    auth_key_b64: String,
    recovery_blob_b64: String,
    recovery_auth_key_b64: String,
}

#[derive(Debug, Serialize)]
struct BlobUpsertBody<'a> {
    blob_kind: &'a str,
    ciphertext_b64: String,
}

/// Несекретный результат десктопной операции над доменом (провижининг, смена
/// NS), уезжающий обратно в `domains.*`.
///
/// Сервер применяет патч через `model_dump(exclude_unset=True)`: опущенное поле
/// он не трогает, а явный `null` — затирает. Поэтому все поля `Option` и все
/// пропускаются при `None`; там, где `null` осмыслен (гашение прошлой ошибки),
/// стоит `Option<Option<_>>`, и `Some(None)` даёт именно `null`.
///
/// Паролей здесь нет и быть не может: полей под них не существует.
#[derive(Debug, Default, Serialize)]
pub struct DomainWriteBack {
    /// Из словаря `DomainStatus` бэкенда (`new` | … | `site_created` |
    /// `active` | `failed`). Колонка `NOT NULL`, поэтому поле именно опускается,
    /// когда сказать нечего: явный `null` тут не 422, а 500.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_path: Option<String>,
    /// Из словаря `SslStatus` бэкенда (`none` | `pending` | `active` | `error`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_user: Option<String>,
    /// Зона домена в Cloudflare. Пишется десктопом после того, как зона заведена
    /// (или найдена уже заведённой): по этой колонке фронт решает, есть ли домену
    /// что показывать в разделе Cloudflare и чем пушить NS, а серверный путь её
    /// заполнить не может — зоны он не видит (zero-knowledge).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cloudflare_zone_id: Option<String>,
    /// Итог смены NS у регистратора: `ok` | `error`. В отличие от `ssl_status`,
    /// enum'а на бэкенде под это НЕТ — колонка голый `String(32)`, и словарь
    /// задаёт фронт (бейдж «NS push to registrar»). Значения — в
    /// `commands::registrars`, там же и почему.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ns_status: Option<String>,
    /// `Some(None)` — погасить прошлую ошибку явным `null`; `None` — не трогать.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_provision_error: Option<Option<String>>,
}

/// Несекретный результат установки FastPanel, уезжающий обратно в `servers.*`.
///
/// `fastpanel_status` в БД `NOT NULL`, а в схеме `Optional[str]`: явный `null`
/// тут — не 422, а 500. Поэтому поле именно опускается, когда сказать нечего.
#[derive(Debug, Default, Serialize)]
pub struct ServerWriteBack {
    /// Из словаря `FastPanelStatus` бэкенда.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fastpanel_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fastpanel_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fastpanel_user: Option<String>,
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        let jar = Arc::new(Jar::default());
        let http = ClientBuilder::new()
            .cookie_provider(jar.clone())
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("reqwest client");
        Self {
            base_url: base_url.into(),
            http,
            jar,
        }
    }

    fn url(&self, path: &str) -> String {
        format!(
            "{}/{}",
            self.base_url.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }

    async fn expect_ok(&self, resp: reqwest::Response) -> Result<(), ApiError> {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.is_success() {
            Ok(())
        } else {
            Err(ApiError::Status {
                status: status.as_u16(),
                body,
            })
        }
    }

    pub async fn register(
        &self,
        email: &str,
        salt: &[u8; 16],
        auth_key: &[u8; 32],
        recovery_blob: &[u8],
        recovery_auth_key: &[u8; 32],
        wrapped_vault_key: &[u8],
    ) -> Result<RegisterResponse, ApiError> {
        let body = RegisterBody {
            email,
            salt_b64: B64.encode(salt),
            auth_key_b64: B64.encode(auth_key),
            recovery_blob_b64: B64.encode(recovery_blob),
            recovery_auth_key_b64: B64.encode(recovery_auth_key),
            wrapped_vault_key_b64: B64.encode(wrapped_vault_key),
        };
        let resp = self
            .http
            .post(self.url("auth/register"))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn login_start(&self, email: &str) -> Result<LoginStartResponse, ApiError> {
        let resp = self
            .http
            .post(self.url("auth/login/start"))
            .json(&LoginStartBody { email })
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn login_finish(
        &self,
        email: &str,
        auth_key: &[u8; 32],
        totp_code: Option<&str>,
    ) -> Result<LoginFinishResponse, ApiError> {
        let body = LoginFinishBody {
            email,
            auth_key_b64: B64.encode(auth_key),
            totp_code,
        };
        let resp = self
            .http
            .post(self.url("auth/login/finish"))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn logout(&self) -> Result<(), ApiError> {
        let resp = self.http.post(self.url("auth/logout")).send().await?;
        self.expect_ok(resp).await
    }

    pub async fn me(&self) -> Result<UserMeResponse, ApiError> {
        let resp = self.http.get(self.url("auth/me")).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn recovery_start(&self, email: &str) -> Result<RecoveryStartResponse, ApiError> {
        let resp = self
            .http
            .post(self.url("auth/recovery/start"))
            .json(&LoginStartBody { email })
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// `new_recovery_auth_key` must be `Some` exactly when the caller issued a new
    /// recovery phrase; otherwise the stored hash would stop matching the phrase.
    pub async fn recovery_finish(
        &self,
        email: &str,
        recovery_auth_key: &[u8; 32],
        new_salt: &[u8; 16],
        new_auth_key: &[u8; 32],
        new_recovery_blob: &[u8],
        new_wrapped_vault_key: &[u8],
        new_recovery_auth_key: Option<&[u8; 32]>,
    ) -> Result<RecoveryFinishResponse, ApiError> {
        let body = RecoveryFinishBody {
            email,
            recovery_auth_key_b64: B64.encode(recovery_auth_key),
            new_salt_b64: B64.encode(new_salt),
            new_auth_key_b64: B64.encode(new_auth_key),
            new_recovery_blob_b64: B64.encode(new_recovery_blob),
            new_wrapped_vault_key_b64: B64.encode(new_wrapped_vault_key),
            new_recovery_auth_key_b64: new_recovery_auth_key.map(|k| B64.encode(k)),
        };
        let resp = self
            .http
            .post(self.url("auth/recovery/finish"))
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    /// Pin the VK wrapper onto an account registered before the vault-key migration
    /// (the column is still NULL). Session cookie required.
    ///
    /// 409 is not a failure to shout about: it means another device won the race and
    /// wrote its own wrapper first. Before the migration VK == KEK, so both wrappers
    /// open into the same key — the caller re-reads `/auth/me` and keeps the stored one.
    pub async fn vault_key_init(&self, wrapped_vault_key: &[u8]) -> Result<(), ApiError> {
        let body = VaultKeyInitBody {
            wrapped_vault_key_b64: B64.encode(wrapped_vault_key),
        };
        let resp = self
            .http
            .post(self.url("auth/vault-key/init"))
            .json(&body)
            .send()
            .await?;
        self.expect_ok(resp).await
    }

    /// Rotate the password: new salt, new auth key, and the same VK under a new wrapper.
    /// Blobs are not part of this request and never were meant to be.
    pub async fn password_change(
        &self,
        old_auth_key: &[u8; 32],
        new_salt: &[u8; 16],
        new_auth_key: &[u8; 32],
        new_wrapped_vault_key: &[u8],
    ) -> Result<(), ApiError> {
        let body = ChangePasswordBody {
            old_auth_key_b64: B64.encode(old_auth_key),
            new_salt_b64: B64.encode(new_salt),
            new_auth_key_b64: B64.encode(new_auth_key),
            new_wrapped_vault_key_b64: B64.encode(new_wrapped_vault_key),
        };
        let resp = self
            .http
            .post(self.url("auth/password/change"))
            .json(&body)
            .send()
            .await?;
        self.expect_ok(resp).await
    }

    /// (Re)configure recovery from a live session. The only way an account whose
    /// `recovery_auth_key_hash` is NULL (registered before migration 014) can regain the
    /// right to use `/auth/recovery/finish`. Requires the session cookie.
    pub async fn recovery_setup(
        &self,
        auth_key: &[u8; 32],
        recovery_blob: &[u8],
        recovery_auth_key: &[u8; 32],
    ) -> Result<(), ApiError> {
        let body = RecoverySetupBody {
            auth_key_b64: B64.encode(auth_key),
            recovery_blob_b64: B64.encode(recovery_blob),
            recovery_auth_key_b64: B64.encode(recovery_auth_key),
        };
        let resp = self
            .http
            .post(self.url("auth/recovery/setup"))
            .json(&body)
            .send()
            .await?;
        self.expect_ok(resp).await
    }

    pub async fn sync_snapshot(&self) -> Result<SyncChangesResponse, ApiError> {
        let resp = self.http.get(self.url("sync/snapshot")).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn sync_changes(&self, since: u64) -> Result<SyncChangesResponse, ApiError> {
        let url = format!("{}?since={}", self.url("sync/changes"), since);
        let resp = self.http.get(url).send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn blob_get(&self, blob_id: &str) -> Result<BlobPayload, ApiError> {
        let resp = self
            .http
            .get(self.url(&format!("blobs/{blob_id}")))
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await?;
        if !status.is_success() {
            return Err(ApiError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(serde_json::from_str(&text)?)
    }

    pub async fn blob_put(&self, blob_id: &str, blob_kind: &str, ciphertext: &[u8]) -> Result<(), ApiError> {
        let body = BlobUpsertBody {
            blob_kind,
            ciphertext_b64: B64.encode(ciphertext),
        };
        let resp = self
            .http
            .put(self.url(&format!("blobs/{blob_id}")))
            .json(&body)
            .send()
            .await?;
        self.expect_ok(resp).await
    }

    pub async fn blob_delete(&self, blob_id: &str) -> Result<(), ApiError> {
        let resp = self
            .http
            .delete(self.url(&format!("blobs/{blob_id}")))
            .send()
            .await?;
        self.expect_ok(resp).await
    }

    /// Push a device-side audit entry (session cookie required). Never put secrets in `metadata`.
    pub async fn audit_log(
        &self,
        action: &str,
        target_type: Option<&str>,
        target_id: Option<&str>,
        device_id: Option<uuid::Uuid>,
        metadata: Option<serde_json::Value>,
    ) -> Result<(), ApiError> {
        let body = serde_json::json!({
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "device_id": device_id,
            "metadata": metadata,
        });
        crate::audit_redact::redact_check_metadata(&body);
        let resp = self.http.post(self.url("audit/log")).json(&body).send().await?;
        self.expect_ok(resp).await
    }

    /// Записать несекретный результат провижининга в домен (`PUT /domains/{id}`).
    ///
    /// Без этого серверные поля (`site_user`, `ssl_status`, `db_name`, …) вечно
    /// пусты, и проверки идемпотентности, которые их читают, сработать не могут.
    pub async fn domain_write_back(
        &self,
        domain_id: &str,
        patch: &DomainWriteBack,
    ) -> Result<(), ApiError> {
        self.put_metadata(&format!("domains/{domain_id}"), patch)
            .await
    }

    /// Записать снимок состояния домена (`POST /domains/{id}/facts`).
    ///
    /// Не `PUT`, как у метаданных провижининга, а `POST` в отдельный роут: время
    /// ставит сервер, а тело описывает ровно один из двух исходов —
    /// `{"facts": {...}}` (успех) либо `{"error": "..."}` (неудача чтения, снимок
    /// на сервере не трогается). Собирает тело вызывающий; здесь — та же
    /// проверка на секретоподобные ИМЕНА полей, что у `put_metadata`: снимок
    /// собран из строк с чужой машины (пути, логины, имена БД), и `POST` их в
    /// БД, поэтому `debug_assert` мало.
    pub async fn domain_facts_write_back(
        &self,
        domain_id: &str,
        body: &serde_json::Value,
    ) -> Result<(), ApiError> {
        if let Err(field) = crate::audit_redact::ensure_no_secrets(body) {
            return Err(ApiError::Secret(field));
        }
        let (status, text) = self
            .request_raw("POST", &format!("domains/{domain_id}/facts"), Some(body))
            .await?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(ApiError::Status { status, body: text })
        }
    }

    /// Записать несекретный результат установки FastPanel (`PUT /servers/{id}`).
    pub async fn server_write_back(
        &self,
        server_id: &str,
        patch: &ServerWriteBack,
    ) -> Result<(), ApiError> {
        self.put_metadata(&format!("servers/{server_id}"), patch)
            .await
    }

    /// PUT несекретных метаданных с проверкой, работающей и в release.
    ///
    /// В отличие от аудита, тело здесь собирается из данных, пришедших с чужого
    /// сервера (имена сайта, БД, URL панели), поэтому `debug_assert` мало:
    /// нашли поле с секретоподобным ИМЕНЕМ — не отправляем вовсе и говорим об
    /// этом вызывающему. Значения не проверяются намеренно: домен
    /// `password.com` не делает тело секретным, а отказ по нему навсегда лишил
    /// бы такие домены write-back'а (см. `audit_redact`).
    ///
    /// `request_raw` на не-2xx не падает, статус разбираем сами.
    async fn put_metadata<T: Serialize>(&self, path: &str, patch: &T) -> Result<(), ApiError> {
        let body = serde_json::to_value(patch)?;
        if let Err(field) = crate::audit_redact::ensure_no_secrets(&body) {
            return Err(ApiError::Secret(field));
        }
        let (status, text) = self.request_raw("PUT", path, Some(&body)).await?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(ApiError::Status { status, body: text })
        }
    }

    /// Generic authenticated proxy. Callers:
    ///
    /// * вебвью десктопа — своей сессионной куки у него нет, поэтому оно ходит
    ///   через этот клиент, а сырой статус + тело возвращаются, чтобы фронт
    ///   сохранил 401/403 и прочее как есть;
    /// * внутрипроцессная [`ApiClient::put_metadata`] — ей нужно то же самое
    ///   «не падать на не-2xx»: статус она разбирает сама.
    pub async fn request_raw(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
    ) -> Result<(u16, String), ApiError> {
        let url = self.url(path);
        let mut req = match method.to_ascii_uppercase().as_str() {
            "GET" => self.http.get(url),
            "POST" => self.http.post(url),
            "PUT" => self.http.put(url),
            "PATCH" => self.http.patch(url),
            "DELETE" => self.http.delete(url),
            other => {
                return Err(ApiError::Status {
                    status: 405,
                    body: format!("unsupported method {other}"),
                })
            }
        };
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        Ok((status, text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_json, header_exists, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn register_sends_expected_json() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/register"))
            .and(body_json(&json!({
                "email": "a@b.c",
                "salt_b64": B64.encode([1u8;16]),
                "auth_key_b64": B64.encode([2u8;32]),
                "recovery_blob_b64": B64.encode(b"blob"),
                "recovery_auth_key_b64": B64.encode([3u8;32]),
                "wrapped_vault_key_b64": B64.encode([7u8;72]),
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"user_id": "u-1"})))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let r = c
            .register("a@b.c", &[1u8; 16], &[2u8; 32], b"blob", &[3u8; 32], &[7u8; 72])
            .await
            .unwrap();
        assert_eq!(r.user_id, "u-1");
    }

    /// The proof key must be on the wire; without it the backend answers 422 and
    /// recovery is dead. Same for the rewrapped vault key: the backend requires it, and
    /// the exact-body matcher makes a dropped field a 404 -> failure.
    #[tokio::test]
    async fn recovery_finish_sends_proof_and_no_rotation_by_default() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/recovery/finish"))
            .and(body_json(&json!({
                "email": "a@b.c",
                "recovery_auth_key_b64": B64.encode([4u8;32]),
                "new_salt_b64": B64.encode([1u8;16]),
                "new_auth_key_b64": B64.encode([2u8;32]),
                "new_recovery_blob_b64": B64.encode(b"blob"),
                "new_wrapped_vault_key_b64": B64.encode([6u8;72]),
                "new_recovery_auth_key_b64": null,
            })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok": true, "user_id": "u-1"})),
            )
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let r = c
            .recovery_finish(
                "a@b.c",
                &[4u8; 32],
                &[1u8; 16],
                &[2u8; 32],
                b"blob",
                &[6u8; 72],
                None,
            )
            .await
            .unwrap();
        assert_eq!(r.user_id.as_deref(), Some("u-1"));
    }

    #[tokio::test]
    async fn recovery_finish_rotates_hash_when_a_new_phrase_was_issued() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/recovery/finish"))
            .and(body_json(&json!({
                "email": "a@b.c",
                "recovery_auth_key_b64": B64.encode([4u8;32]),
                "new_salt_b64": B64.encode([1u8;16]),
                "new_auth_key_b64": B64.encode([2u8;32]),
                "new_recovery_blob_b64": B64.encode(b"blob"),
                "new_wrapped_vault_key_b64": B64.encode([6u8;72]),
                "new_recovery_auth_key_b64": B64.encode([5u8;32]),
            })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok": true, "user_id": "u-1"})),
            )
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.recovery_finish(
            "a@b.c",
            &[4u8; 32],
            &[1u8; 16],
            &[2u8; 32],
            b"blob",
            &[6u8; 72],
            Some(&[5u8; 32]),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn recovery_finish_surfaces_wrong_key_401() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/recovery/finish"))
            .respond_with(
                ResponseTemplate::new(401).set_body_json(json!({"detail": "invalid recovery key"})),
            )
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let err = c
            .recovery_finish(
                "a@b.c",
                &[4u8; 32],
                &[1u8; 16],
                &[2u8; 32],
                b"blob",
                &[6u8; 72],
                None,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::Status { status: 401, .. }));
    }

    /// Обёртка VK из ответа входа — то, чем десктоп открывает всё остальное.
    #[tokio::test]
    async fn login_finish_reads_the_vault_key_wrapper() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/login/finish"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "user_id": "u-1",
                "wrapped_vault_key_b64": B64.encode([8u8;72]),
            })))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let r = c.login_finish("a@b.c", &[9u8; 32], None).await.unwrap();
        assert_eq!(
            r.wrapped_vault_key_b64.as_deref(),
            Some(B64.encode([8u8; 72]).as_str())
        );
    }

    /// `null` и отсутствие поля — одно и то же состояние: «аккаунт заведён до
    /// перехода», по которому идёт ленивая миграция. Споткнись разбор здесь — ни один
    /// старый аккаунт не смог бы войти вовсе, поэтому проверяются обе формы ответа.
    #[tokio::test]
    async fn login_finish_without_a_wrapper_reads_as_none() {
        for body in [
            json!({"user_id": "u-1"}),
            json!({"user_id": "u-1", "wrapped_vault_key_b64": null}),
        ] {
            let srv = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/api/auth/login/finish"))
                .respond_with(ResponseTemplate::new(200).set_body_json(body.clone()))
                .mount(&srv)
                .await;

            let c = ApiClient::new(format!("{}/api", srv.uri()));
            let r = c.login_finish("a@b.c", &[9u8; 32], None).await.unwrap();
            assert_eq!(r.user_id, "u-1");
            assert_eq!(r.wrapped_vault_key_b64, None, "{body}");
        }
    }

    #[tokio::test]
    async fn vault_key_init_sends_the_wrapper() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/vault-key/init"))
            .and(body_json(&json!({
                "wrapped_vault_key_b64": B64.encode([6u8;72]),
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
            .expect(1)
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.vault_key_init(&[6u8; 72]).await.unwrap();
    }

    /// 409 обязан доехать до вызывающего как статус, а не как «api error»-строка:
    /// именно по нему он решает перечитать `/auth/me` и взять чужую обёртку вместо
    /// своей. Схлопни это в общую ошибку — вход у проигравшего гонку встанет.
    #[tokio::test]
    async fn vault_key_init_surfaces_the_409_of_a_lost_race() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/vault-key/init"))
            .respond_with(
                ResponseTemplate::new(409)
                    .set_body_json(json!({"detail": "vault key already initialized"})),
            )
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let err = c.vault_key_init(&[6u8; 72]).await.unwrap_err();
        assert!(matches!(err, ApiError::Status { status: 409, .. }));
    }

    /// Точный матчер тела здесь держит главное свойство смены пароля: в запросе
    /// ровно четыре поля и ни одного блоба. Поле `re_encrypted_blobs` из контракта
    /// исчезло вместе с необходимостью что-либо перешифровывать.
    #[tokio::test]
    async fn password_change_sends_the_new_wrapper_and_nothing_about_blobs() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/password/change"))
            .and(body_json(&json!({
                "old_auth_key_b64": B64.encode([1u8;32]),
                "new_salt_b64": B64.encode([2u8;16]),
                "new_auth_key_b64": B64.encode([3u8;32]),
                "new_wrapped_vault_key_b64": B64.encode([4u8;72]),
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
            .expect(1)
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.password_change(&[1u8; 32], &[2u8; 16], &[3u8; 32], &[4u8; 72])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn recovery_setup_sends_step_up_auth_key_and_uses_session_cookie() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/login/finish"))
            .respond_with(
                ResponseTemplate::new(200)
                    .append_header("Set-Cookie", "sdmp_session=tok; Path=/")
                    .set_body_json(json!({"user_id": "u-1"})),
            )
            .mount(&srv)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/auth/recovery/setup"))
            .and(header_exists("cookie"))
            .and(body_json(&json!({
                "auth_key_b64": B64.encode([2u8;32]),
                "recovery_blob_b64": B64.encode(b"blob"),
                "recovery_auth_key_b64": B64.encode([3u8;32]),
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"ok": true})))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.login_finish("a@b.c", &[9u8; 32], None).await.unwrap();
        c.recovery_setup(&[2u8; 32], b"blob", &[3u8; 32])
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn recovery_setup_surfaces_wrong_password_401() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/recovery/setup"))
            .respond_with(
                ResponseTemplate::new(401)
                    .set_body_json(json!({"detail": "invalid current password"})),
            )
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let err = c
            .recovery_setup(&[2u8; 32], b"blob", &[3u8; 32])
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::Status { status: 401, .. }));
    }

    #[tokio::test]
    async fn login_sets_cookie_and_me_uses_it() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/login/finish"))
            .respond_with(
                ResponseTemplate::new(200)
                    .append_header("Set-Cookie", "sdmp_session=tok; Path=/")
                    .set_body_json(json!({"user_id": "u-1"})),
            )
            .mount(&srv)
            .await;

        Mock::given(method("GET"))
            .and(path("/api/auth/me"))
            .and(header_exists("cookie"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "00000000-0000-0000-0000-000000000001",
                "email": "a@b.c",
                "email_confirmed_at": null,
                "totp_enabled": false
            })))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.login_finish("a@b.c", &[9u8; 32], None).await.unwrap();
        let me = c.me().await.unwrap();
        assert_eq!(me.email, "a@b.c");
        // Поля нет в ответе — «не знаю», и me() из-за этого не падает.
        assert_eq!(me.recovery_configured, None);
    }

    #[tokio::test]
    async fn me_reports_recovery_configured_when_the_server_says_so() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/auth/me"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "00000000-0000-0000-0000-000000000001",
                "email": "a@b.c",
                "email_confirmed_at": null,
                "totp_enabled": false,
                "recovery_configured": false
            })))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        // Явное false отличается от отсутствия поля: одно — «восстановиться нельзя»,
        // другое — «сервер не в курсе вопроса».
        assert_eq!(c.me().await.unwrap().recovery_configured, Some(false));
    }

    #[tokio::test]
    async fn request_raw_reuses_session_cookie_and_passes_status() {
        let srv = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/auth/login/finish"))
            .respond_with(
                ResponseTemplate::new(200)
                    .append_header("Set-Cookie", "sdmp_session=tok; Path=/")
                    .set_body_json(json!({"user_id": "u-1"})),
            )
            .mount(&srv)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/servers"))
            .and(header_exists("cookie"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([{"id": "s1"}])))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.login_finish("a@b.c", &[9u8; 32], None).await.unwrap();
        let (status, body) = c.request_raw("GET", "/servers", None).await.unwrap();
        assert_eq!(status, 200);
        assert!(body.contains("s1"));
    }

    /// Write-back шлёт PUT (не PATCH) и ровно те поля, которые знает: сервер
    /// применяет `exclude_unset`, поэтому лишний ключ затёр бы чужие данные.
    #[tokio::test]
    async fn domain_write_back_puts_only_the_known_fields() {
        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/domains/42"))
            .and(body_json(json!({
                "site_user": "u1",
                "site_path": "/var/www/u1/data/www/example.com",
                "ssl_status": "active",
                "last_provision_error": null,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": 42})))
            // Без `.expect(1)` расхождение в теле выглядело бы как 404 от
            // незамэтченного запроса, упавший через `.unwrap()`, — ни диффа,
            // ни намёка, что дело в теле.
            .expect(1)
            .named("PUT /domains/42 with exactly the known fields")
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.domain_write_back(
            "42",
            &DomainWriteBack {
                site_user: Some("u1".into()),
                site_path: Some("/var/www/u1/data/www/example.com".into()),
                ssl_status: Some("active".into()),
                last_provision_error: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn server_write_back_puts_fastpanel_metadata() {
        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/servers/7"))
            .and(body_json(json!({
                "fastpanel_status": "installed",
                "fastpanel_url": "https://1.2.3.4:8888",
                "fastpanel_user": "fastuser",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": 7})))
            .expect(1)
            .named("PUT /servers/7 with fastpanel metadata")
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.server_write_back(
            "7",
            &ServerWriteBack {
                fastpanel_status: Some("installed".into()),
                fastpanel_url: Some("https://1.2.3.4:8888".into()),
                fastpanel_user: Some("fastuser".into()),
            },
        )
        .await
        .unwrap();
    }

    /// Не-2xx обязан дойти до вызывающего: он решает, что делать (у нас —
    /// варнинг и событие прогресса), а молча «успешно» отвечать нельзя.
    #[tokio::test]
    async fn domain_write_back_surfaces_a_server_error() {
        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/domains/42"))
            .respond_with(ResponseTemplate::new(500).set_body_json(json!({"detail": "boom"})))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let err = c
            .domain_write_back(
                "42",
                &DomainWriteBack {
                    site_user: Some("u1".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::Status { status: 500, .. }));
    }

    /// Пустой патч — пустое тело: `exclude_unset` на сервере не тронет ничего.
    /// Отдельным тестом, а не первой строкой три-стейта: он держит ВСЕ поля
    /// структуры, и тот, кто однажды добавит поле с непустым `Default`, должен
    /// получить падение с именем, ведущим туда, где правда.
    #[test]
    fn default_write_back_body_serializes_to_nothing() {
        assert_eq!(
            serde_json::to_string(&DomainWriteBack::default()).unwrap(),
            "{}"
        );
        assert_eq!(
            serde_json::to_string(&ServerWriteBack::default()).unwrap(),
            "{}"
        );
    }

    /// Три состояния `last_provision_error` — три разные операции на сервере
    /// (`exclude_unset`): не трогать, погасить, записать. Сегодня провижининг
    /// пользуется первыми двумя, но `Some(Some(_))` — половина этого договора,
    /// и молчаливо сломаться она не должна.
    #[test]
    fn last_provision_error_tri_state_serializes_as_three_operations() {
        let omit = DomainWriteBack {
            site_user: Some("u1".into()),
            last_provision_error: None,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&omit).unwrap(),
            "{\"site_user\":\"u1\"}"
        );

        let clear = DomainWriteBack {
            last_provision_error: Some(None),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&clear).unwrap(),
            "{\"last_provision_error\":null}"
        );

        let set = DomainWriteBack {
            last_provision_error: Some(Some("ssh: auth failed".into())),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_string(&set).unwrap(),
            "{\"last_provision_error\":\"ssh: auth failed\"}"
        );
    }

    /// Инвариант ZK: тело с секретоподобным ИМЕНЕМ поля не уходит в сеть
    /// вообще. `.expect(0)` проверяется на drop сервера — то есть отказ
    /// настоящий, а не «отправили и получили ошибку».
    ///
    /// Идём через приватную `put_metadata` с сырым телом: в `DomainWriteBack`
    /// поля под пароль нет вовсе, и собрать через неё плохое тело невозможно —
    /// это первая линия обороны, а тест проверяет вторую.
    #[tokio::test]
    async fn put_metadata_refuses_to_send_a_body_with_a_secret_field() {
        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/domains/42"))
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let err = c
            .put_metadata(
                "domains/42",
                &json!({"site_user": "u1", "db_password": "s3cret"}),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(&err, ApiError::Secret(f) if f == "db_password"),
            "{err}"
        );
    }

    /// Обратная сторона того же инварианта: `site_path` домена `password.com`
    /// содержит «password» в значении, и это НЕ повод не записать результат.
    /// Иначе такие домены навсегда остались бы без `site_user` на сервере, а
    /// проверка `site_exists` для них не сработала бы никогда.
    #[tokio::test]
    async fn domain_write_back_sends_a_password_shaped_domain() {
        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/domains/42"))
            .and(body_json(json!({
                "site_user": "password_com",
                "site_path": "/var/www/password_com/data/www/password.com",
                "ssl_status": "active",
                "last_provision_error": null,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": 42})))
            .expect(1)
            .named("PUT /domains/42 for a password-shaped domain")
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        c.domain_write_back(
            "42",
            &DomainWriteBack {
                site_user: Some("password_com".into()),
                site_path: Some("/var/www/password_com/data/www/password.com".into()),
                ssl_status: Some("active".into()),
                last_provision_error: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn request_raw_passes_through_unauthenticated_401() {
        let srv = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/servers"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({"detail": "missing session"})))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let (status, _body) = c.request_raw("GET", "/servers", None).await.unwrap();
        assert_eq!(status, 401);
    }
}
