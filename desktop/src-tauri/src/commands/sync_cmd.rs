use std::sync::Mutex;
use tauri::{Manager, State};

use crate::commands::auth::CommandError;
use crate::keychain;
use crate::sync::cache;
use crate::sync::client::SyncClient;
use crate::sync::http::ApiClient;

pub struct SyncHandle(pub Mutex<Option<SyncClient>>);

#[tauri::command]
pub async fn sync_now(handle: State<'_, SyncHandle>, user_id: String) -> Result<u64, CommandError> {
    let (api, cache_path) = {
        let guard = handle.0.lock().map_err(|e| CommandError::Api(e.to_string()))?;
        let c = guard
            .as_ref()
            .ok_or_else(|| CommandError::Api("sync not initialized".into()))?;
        (c.api.clone(), c.cache_path.clone())
    };
    let client = SyncClient::new(api, cache_path);
    client
        .pull(&user_id)
        .await
        .map_err(|e| CommandError::Api(e.to_string()))
}

#[tauri::command]
pub fn sync_init(
    app: tauri::AppHandle,
    user_id: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<(), CommandError> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| CommandError::Api(e.to_string()))?;
    std::fs::create_dir_all(&dir).map_err(|e| CommandError::Api(e.to_string()))?;
    let cache_path = dir.join("cache.db");
    let key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    cache::open(&cache_path, &key).map_err(|e| CommandError::Api(e.to_string()))?;
    let client = SyncClient::new((*api).clone(), cache_path);
    let mut g = handle.0.lock().map_err(|e| CommandError::Api(e.to_string()))?;
    *g = Some(client);
    Ok(())
}
