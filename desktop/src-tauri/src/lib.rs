use tracing_subscriber::EnvFilter;

mod cloudflare;
mod commands;
mod crypto;
mod keychain;
mod provision;
mod registrars;
mod ssh;
mod sync;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
