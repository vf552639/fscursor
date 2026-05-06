use std::sync::Mutex;

use tracing_subscriber::EnvFilter;

mod cloudflare;
mod commands;
mod crypto;
mod keychain;
mod provision;
mod registrars;
mod ssh;
mod sync;

use commands::sync_cmd::SyncHandle;
use sync::http::ApiClient;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let api = ApiClient::new(
        std::env::var("SDMP_API_URL").unwrap_or_else(|_| "http://localhost:8100/api".into()),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SyncHandle(Mutex::new(None)))
        .manage(api)
        .invoke_handler(tauri::generate_handler![
            commands::auth::auth_register,
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_recovery,
            commands::vault::vault_decrypt_blob,
            commands::vault::vault_put_blob,
            commands::vault::vault_delete_blob,
            commands::sync_cmd::sync_init,
            commands::sync_cmd::sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
