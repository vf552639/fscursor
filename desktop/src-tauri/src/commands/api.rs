use serde::Serialize;
use tauri::State;

use crate::commands::auth::CommandError;
use crate::sync::http::ApiClient;

#[derive(Serialize)]
pub struct ApiResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

/// Proxy a webview HTTP call through the authenticated Rust client.
///
/// The desktop webview holds no session cookie (the session lives in this
/// client's `reqwest` jar), so all JSON API traffic is routed here. The raw
/// status is passed back so the frontend can raise the correct `ApiError`
/// (401/403/…) instead of everything collapsing to a network error.
#[tauri::command]
pub async fn api_request(
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    api: State<'_, ApiClient>,
) -> Result<ApiResponse, CommandError> {
    let (status, text) = api
        .request_raw(&method, &path, body.as_ref())
        .await
        .map_err(|e| CommandError::Api(e.to_string()))?;
    let value = if text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null)
    };
    Ok(ApiResponse { status, body: value })
}
