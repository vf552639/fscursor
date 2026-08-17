use std::sync::Mutex;

use tracing_subscriber::EnvFilter;

mod audit_redact;
mod cloudflare;
mod commands;
mod crypto;
mod keychain;
mod provision;
mod rdap;
mod registrars;
pub mod ssh;
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
        .plugin(tauri_plugin_deep_link::init())
        // Единственный способ спросить у человека «да/нет» в десктопе:
        // `window.confirm` в webview не показывает ничего и возвращает `false`
        // (подробности у зависимости в `Cargo.toml`).
        .plugin(tauri_plugin_dialog::init())
        .manage(SyncHandle(Mutex::new(None)))
        .manage(api)
        .invoke_handler(tauri::generate_handler![
            commands::api::api_request,
            commands::auth::auth_register,
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_recovery,
            commands::auth::auth_recovery_setup,
            commands::auth::auth_recovery_status,
            commands::auth::auth_change_password,
            commands::vault::vault_decrypt_blob,
            commands::vault::vault_put_blob,
            commands::vault::vault_delete_blob,
            commands::sync_cmd::sync_init,
            commands::sync_cmd::sync_now,
            commands::ssh::ssh_accept_host_key,
            commands::ssh::ssh_exec,
            commands::provision::provision_domain,
            commands::provision::provision_bulk,
            commands::provision::install_fastpanel,
            commands::provision::server_list_sites,
            commands::domain_facts::domain_read_facts,
            commands::cloudflare::cf_verify_token,
            commands::cloudflare::cf_list_zones,
            commands::cloudflare::cf_list_dns_records,
            commands::cloudflare::cf_create_zone,
            commands::cloudflare::cf_create_dns_record,
            commands::cloudflare::cf_update_dns_record,
            commands::cloudflare::cf_delete_dns_record,
            commands::cloudflare::cf_purge_cache,
            commands::rdap::domain_registry_nameservers,
            commands::registrars::registrar_test_connection,
            commands::registrars::registrar_get_domains,
            commands::registrars::registrar_set_nameservers,
            commands::full_setup::domain_full_setup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
