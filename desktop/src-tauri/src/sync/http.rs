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
    /// Only when recovery issued a NEW phrase; null keeps the stored hash. Sending the
    /// wrong thing here (or nothing, after a rotation) makes the account unrecoverable.
    new_recovery_auth_key_b64: Option<String>,
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
    ) -> Result<RegisterResponse, ApiError> {
        let body = RegisterBody {
            email,
            salt_b64: B64.encode(salt),
            auth_key_b64: B64.encode(auth_key),
            recovery_blob_b64: B64.encode(recovery_blob),
            recovery_auth_key_b64: B64.encode(recovery_auth_key),
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
        new_recovery_auth_key: Option<&[u8; 32]>,
    ) -> Result<RecoveryFinishResponse, ApiError> {
        let body = RecoveryFinishBody {
            email,
            recovery_auth_key_b64: B64.encode(recovery_auth_key),
            new_salt_b64: B64.encode(new_salt),
            new_auth_key_b64: B64.encode(new_auth_key),
            new_recovery_blob_b64: B64.encode(new_recovery_blob),
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

    /// Generic authenticated proxy used by the desktop webview, which has no
    /// session cookie of its own. Reuses this client's cookie jar and returns
    /// the raw status + body so the frontend can preserve 401/403/etc.
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
            })))
            .respond_with(ResponseTemplate::new(201).set_body_json(json!({"user_id": "u-1"})))
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let r = c
            .register("a@b.c", &[1u8; 16], &[2u8; 32], b"blob", &[3u8; 32])
            .await
            .unwrap();
        assert_eq!(r.user_id, "u-1");
    }

    /// The proof key must be on the wire; without it the backend answers 422 and
    /// recovery is dead. The exact-body matcher makes a dropped field a 404 -> failure.
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
                "new_recovery_auth_key_b64": null,
            })))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({"ok": true, "user_id": "u-1"})),
            )
            .mount(&srv)
            .await;

        let c = ApiClient::new(format!("{}/api", srv.uri()));
        let r = c
            .recovery_finish("a@b.c", &[4u8; 32], &[1u8; 16], &[2u8; 32], b"blob", None)
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
            .recovery_finish("a@b.c", &[4u8; 32], &[1u8; 16], &[2u8; 32], b"blob", None)
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::Status { status: 401, .. }));
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
