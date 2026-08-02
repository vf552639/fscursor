use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_i64, json_str};
use crate::commands::ssh::{ssh_connect_session, ssh_connect_session_with_timeout};
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::provision::bulk;
use crate::provision::fastpanel_install::{
    parse_fastpanel_credentials, update_command, FpCredentials, INSTALL_CMD,
};
use crate::ssh::client::{SshError, SshSession};
use crate::ssh::fastpanel::{self, CreateSiteResult};
use crate::sync::cache;
use crate::sync::http::ApiClient;

#[derive(Serialize)]
pub struct ProvisionResultOut {
    pub domain_id: String,
    pub site_user: String,
    pub site_path: String,
}

#[derive(Serialize)]
pub struct InstallFastpanelResult {
    pub server_id: String,
    pub url: Option<String>,
    pub user: Option<String>,
    /// Пароль панели: чувствительно, показывать по образцу RevealSecret.
    pub password: Option<String>,
}

pub async fn run_provision_domain(
    app: &AppHandle,
    user_id: &str,
    domain_id: &str,
    site_only: bool,
    cache_path: &Path,
    api: &ApiClient,
) -> Result<ProvisionResultOut, CommandError> {
    let key = keychain::load_master_key(user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let conn = cache::open(cache_path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let domain_row = cache::get_row_fields(&conn, "domains", domain_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("domain not in local cache".into()))?;

    let server_id = json_i64(
        domain_row
            .get("server_id")
            .ok_or_else(|| CommandError::Api("domain has no server_id".into()))?,
    )
    .ok_or_else(|| CommandError::Api("invalid server_id".into()))?
    .to_string();

    let server_row = cache::get_row_fields(&conn, "servers", &server_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("server not in local cache".into()))?;

    let blob_id = server_row
        .get("ssh_password_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server has no ssh_password_blob_id".into()))?;

    let password = blob_plaintext(api, &key, &blob_id).await?;
    let host = server_row
        .get("ip_address")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server missing ip_address".into()))?;
    let port = server_row
        .get("ssh_port")
        .and_then(json_i64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let ssh_user = server_row
        .get("ssh_user")
        .and_then(json_str)
        .unwrap_or_else(|| "root".into());

    let domain_name = domain_row
        .get("domain_name")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("domain missing domain_name".into()))?;
    let php_version = domain_row
        .get("php_version")
        .and_then(json_str)
        .unwrap_or_else(|| "8.1".into());

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "ssh_connect", "domain_id": domain_id }),
    );

    let mut session = ssh_connect_session(app, &host, port, &ssh_user, &password).await?;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "fastpanel_path", "domain_id": domain_id }),
    );
    let fp_path = fastpanel::get_fastpanel_path(&mut session, None)
        .await?
        .ok_or_else(|| CommandError::Api("fastpanel binary not found on server".into()))?;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "firewall_preflight", "domain_id": domain_id }),
    );
    let ports = fastpanel::ensure_ports_open(&mut session, &[80, 443]).await?;
    if !ports.success {
        tracing::warn!(target: "provision", "firewall preflight: {:?}", ports.error);
    }

    let site_user_existing = domain_row.get("site_user").and_then(json_str);
    let CreateSiteResult {
        site_user,
        site_path,
        ..
    } = if let Some(ref u) = site_user_existing {
        if fastpanel::site_exists(&mut session, u, &domain_name).await? {
            CreateSiteResult {
                site_user: u.clone(),
                site_path: format!("/var/www/{u}/data/www/{domain_name}"),
                output: "already exists".into(),
            }
        } else {
            fastpanel::create_site(&mut session, &fp_path, &domain_name, &php_version).await?
        }
    } else {
        fastpanel::create_site(&mut session, &fp_path, &domain_name, &php_version).await?
    };

    if !site_only {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "ftp", "domain_id": domain_id }),
        );
        let _ftp = fastpanel::create_ftp_account(&mut session, &fp_path, &domain_name).await?;
    }

    let _ = session.disconnect().await;

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());

    api.audit_log(
        "device.action.complete",
        Some("domain"),
        Some(domain_id),
        device_id,
        Some(serde_json::json!({
            "steps": ["ssh", "create_site"],
            "domain_name": domain_name,
            "server_id": server_id,
            "site_only": site_only,
        })),
    )
    .await
    .map_err(|e| CommandError::Api(e.to_string()))?;

    Ok(ProvisionResultOut {
        domain_id: domain_id.to_string(),
        site_user,
        site_path,
    })
}

#[tauri::command]
pub async fn provision_domain(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    site_only: bool,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<ProvisionResultOut, CommandError> {
    let cache_path = cache_path(&handle)?;
    run_provision_domain(&app, &user_id, &domain_id, site_only, &cache_path, &api).await
}

#[tauri::command]
pub async fn provision_bulk(
    app: AppHandle,
    user_id: String,
    domain_ids: Vec<String>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<String, CommandError> {
    let key = idempotency_key("provision_bulk", &domain_ids);
    let cache_path = cache_path(&handle)?;
    let mk = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let conn = cache::open(&cache_path, &mk).map_err(|e| CommandError::Api(e.to_string()))?;

    if let Some((st, _)) =
        cache::bulk_run_status(&conn, &key).map_err(|e| CommandError::Api(e.to_string()))?
    {
        if st == "running" || st == "done" {
            return Ok(key);
        }
    }
    cache::bulk_run_upsert_start(
        &conn,
        &key,
        "provision_bulk",
        &serde_json::to_string(&domain_ids).unwrap_or_default(),
    )
    .map_err(|e| CommandError::Api(e.to_string()))?;

    for did in &domain_ids {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "bulk_item", "domain_id": did }),
        );
        run_provision_domain(&app, &user_id, did, false, &cache_path, &api).await?;
    }
    cache::bulk_run_complete(&conn, &key, "ok").map_err(|e| CommandError::Api(e.to_string()))?;
    Ok(key)
}

fn idempotency_key(action: &str, domain_ids: &[String]) -> String {
    bulk::idempotency_key(action, domain_ids)
}

/// Сколько молчания сервера считаем обрывом связи во время установки FastPanel.
///
/// Уходит в `inactivity_timeout` russh. И `apt-get upgrade`, и инсталлятор
/// непрерывно пишут в вывод, поэтому 5 минут полной тишины = мёртвый коннект,
/// тогда как дефолтные 45s убили бы живую многоминутную операцию.
const FP_SESSION_TIMEOUT: Duration = Duration::from_secs(300);
/// Обновление системы: apt/yum на свежей VPS укладывается в ~10 минут.
const FP_UPDATE_TIMEOUT: Duration = Duration::from_secs(900);
/// Инсталлятор FastPanel тянет nginx/apache/mysql/php — закладываем 30 минут.
const FP_INSTALL_TIMEOUT: Duration = Duration::from_secs(1800);
/// Сколько последних строк вывода апдейта прикладывать к тексту ошибки.
const FP_UPDATE_TAIL_LINES: usize = 30;

/// Последние `n` строк вывода — хвост для диагностики упавшего шага.
fn tail_lines(output: &str, n: usize) -> String {
    let lines: Vec<&str> = output.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Ошибка `exec` с контекстом шага.
///
/// `SshSession::exec` отдаёт таймаут как безликое `SshError::Session("exec
/// timeout")` — ни шага, ни лимита. Подменяем текст, остальные ошибки
/// пробрасываем как есть.
fn exec_error(step: &str, timeout: Duration, e: SshError) -> CommandError {
    if matches!(&e, SshError::Session(m) if m == "exec timeout") {
        CommandError::Api(format!("{step} timed out after {}s", timeout.as_secs()))
    } else {
        CommandError::from(e)
    }
}

/// Шаги установки внутри уже открытой сессии. Возвращает разобранные креды.
///
/// Вынесено отдельно по двум причинам: вызывающий гарантированно закрывает
/// сессию ровно один раз на любом пути выхода (ошибка exec, ненулевой код,
/// успех), а сырой вывод инсталлятора (в нём пароль панели) не переживает этот
/// стык — наружу уходит только разобранный `FpCredentials`.
async fn run_fastpanel_install_steps(
    app: &AppHandle,
    session: &mut SshSession,
    server_id: &str,
    os: &str,
) -> Result<FpCredentials, CommandError> {
    let _ = app.emit(
        "fastpanel:progress",
        serde_json::json!({ "step": "updating", "server_id": server_id }),
    );
    let (upd_code, upd_out) = session
        .exec(&update_command(os), FP_UPDATE_TIMEOUT, false)
        .await
        .map_err(|e| exec_error("system update", FP_UPDATE_TIMEOUT, e))?;
    if upd_code != 0 {
        // Вывод apt/yum секретов не содержит — прикладываем хвост, иначе у
        // пользователя остаётся только код возврата.
        let msg = format!("system update failed (exit {upd_code})");
        let tail = tail_lines(&upd_out, FP_UPDATE_TAIL_LINES);
        return Err(CommandError::Api(if tail.is_empty() {
            msg
        } else {
            format!("{msg}\n{tail}")
        }));
    }

    let _ = app.emit(
        "fastpanel:progress",
        serde_json::json!({ "step": "installing", "server_id": server_id }),
    );
    let (inst_code, inst_out) = session
        .exec(INSTALL_CMD, FP_INSTALL_TIMEOUT, false)
        .await
        .map_err(|e| exec_error("fastpanel installer", FP_INSTALL_TIMEOUT, e))?;
    if inst_code != 0 {
        // В отличие от апдейта, вывод инсталлятора содержит пароль панели —
        // наружу отдаём только код возврата, без хвоста.
        return Err(CommandError::Api(format!(
            "fastpanel installer failed (exit {inst_code})"
        )));
    }

    let creds = parse_fastpanel_credentials(&inst_out);
    if creds.password.is_none() {
        // Инсталлятор отработал, но формат вывода изменился и пароль не
        // достался. Молчать нельзя: пользователь решит, что всё хорошо, а
        // пароль панели не существует больше нигде.
        let _ = app.emit(
            "fastpanel:progress",
            serde_json::json!({ "step": "creds_unparsed", "server_id": server_id }),
        );
    }
    Ok(creds)
}

#[tauri::command]
pub async fn install_fastpanel(
    app: AppHandle,
    user_id: String,
    server_id: String,
    force: bool,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<InstallFastpanelResult, CommandError> {
    let key = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(&handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let server_row = cache::get_row_fields(&conn, "servers", &server_id)
        .map_err(|e| CommandError::Api(e.to_string()))?
        .ok_or_else(|| CommandError::Api("server not in local cache".into()))?;

    // Идемпотентность: не переустанавливаем, если уже установлено (кроме force).
    let fp_status = server_row
        .get("fastpanel_status")
        .and_then(json_str)
        .unwrap_or_default();
    if fp_status == "installed" && !force {
        return Err(CommandError::Api(
            "FastPanel already installed on this server (use force to reinstall)".into(),
        ));
    }

    // Без ОС `update_command` молча уходит в apt-ветку, и RHEL-сервер падает на
    // невнятном коде возврата уже после подключения. Отсекаем сразу.
    let os = server_row.get("os").and_then(json_str).unwrap_or_default();
    if os.trim().is_empty() {
        return Err(CommandError::Api(
            "server has no OS recorded — set it before installing FastPanel (decides apt vs yum)"
                .into(),
        ));
    }

    let blob_id = server_row
        .get("ssh_password_blob_id")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server has no ssh_password_blob_id".into()))?;
    let password = blob_plaintext(&api, &key, &blob_id).await?;
    let host = server_row
        .get("ip_address")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("server missing ip_address".into()))?;
    let port = server_row
        .get("ssh_port")
        .and_then(json_i64)
        .map(|p| p as u16)
        .unwrap_or(22);
    let ssh_user = server_row
        .get("ssh_user")
        .and_then(json_str)
        .unwrap_or_else(|| "root".into());

    // Всё, что нужно из локального кэша, забираем до SSH: держать соединение с
    // SQLCipher открытым все 30-40 минут установки незачем.
    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());
    drop(conn);

    let _ = app.emit(
        "fastpanel:progress",
        serde_json::json!({ "step": "ssh_connect", "server_id": server_id }),
    );
    let mut session = ssh_connect_session_with_timeout(
        &app,
        &host,
        port,
        &ssh_user,
        &password,
        FP_SESSION_TIMEOUT,
    )
    .await?;

    let installed = run_fastpanel_install_steps(&app, &mut session, &server_id, &os).await;
    let _ = session.disconnect().await;
    let creds = installed?;

    // metadata без пароля (redaction guard в http.rs — debug_assert, в release
    // его нет, поэтому чистота метаданных обеспечивается здесь).
    //
    // Аудит — best-effort, и намеренно: FastPanel уже установлен, а пароль панели
    // существует только в этом ответе, поэтому `?` здесь потерял бы его навсегда.
    // Не превращать обратно в `?`. Но «best-effort» не значит «молча»: помимо
    // варнинга в лог шлём тот же `fastpanel:progress`, что и остальные шаги, —
    // один слушатель на фронте покажет, что действие осталось незаписанным.
    if let Err(e) = api
        .audit_log(
            "server.fastpanel_install",
            Some("server"),
            Some(&server_id),
            device_id,
            Some(serde_json::json!({ "url": creds.url, "user": creds.user })),
        )
        .await
    {
        tracing::warn!(target: "provision", "audit log for fastpanel_install failed: {e}");
        let _ = app.emit(
            "fastpanel:progress",
            serde_json::json!({ "step": "audit_failed", "server_id": server_id }),
        );
    }

    Ok(InstallFastpanelResult {
        server_id,
        url: creds.url,
        user: creds.user,
        password: creds.password,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_lines_returns_whole_output_when_shorter_than_limit() {
        assert_eq!(tail_lines("a\nb\nc", 30), "a\nb\nc");
    }

    #[test]
    fn tail_lines_keeps_only_the_last_n_lines() {
        let out = (1..=50)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(tail_lines(&out, 3), "48\n49\n50");
    }

    #[test]
    fn tail_lines_of_empty_output_is_empty() {
        assert_eq!(tail_lines("", 30), "");
    }

    // `exec` reports a timeout as a bare `SshError::Session("exec timeout")`,
    // which names neither the step nor the limit that was exceeded.
    #[test]
    fn exec_error_names_step_and_limit_on_timeout() {
        let e = exec_error(
            "system update",
            Duration::from_secs(900),
            SshError::Session("exec timeout".into()),
        );
        assert_eq!(e.to_string(), "api: system update timed out after 900s");
    }

    // Anything that is not the timeout must keep its original message.
    #[test]
    fn exec_error_passes_through_non_timeout_errors() {
        let e = exec_error("fastpanel installer", FP_INSTALL_TIMEOUT, SshError::Auth);
        assert_eq!(e.to_string(), "ssh: auth failed");
        let e = exec_error(
            "fastpanel installer",
            FP_INSTALL_TIMEOUT,
            SshError::Session("channel closed".into()),
        );
        assert_eq!(e.to_string(), "ssh: session: channel closed");
    }
}
