use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::commands::auth::CommandError;
use crate::commands::creds::{blob_plaintext, cache_path, json_i64, json_str};
use crate::commands::ssh::ssh_connect_session_with_timeout;
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::provision::bulk;
use crate::provision::fastpanel_install::{
    parse_fastpanel_credentials, update_command, FpCredentials, INSTALL_CMD,
};
use crate::ssh::client::{SshError, SshSession};
use crate::ssh::fastpanel::{self, CreateDbResult, CreateSiteResult};
use crate::sync::cache;
use crate::sync::http::ApiClient;

#[derive(Serialize)]
pub struct ProvisionResultOut {
    pub domain_id: String,
    pub site_user: String,
    pub site_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_issued: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ssl_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db: Option<DbInfoOut>,
}

/// Реквизиты созданной БД. Намеренно без `Debug`: `db_password` существует
/// только здесь, и случайный `{:?}` не должен уносить его в лог.
#[derive(Serialize)]
pub struct DbInfoOut {
    pub db_name: String,
    pub db_user: String,
    /// Пароль БД: чувствительно, показывать по образцу RevealSecret.
    pub db_password: String,
}

#[derive(Serialize)]
pub struct InstallFastpanelResult {
    pub server_id: String,
    pub url: Option<String>,
    pub user: Option<String>,
    /// Пароль панели: чувствительно, показывать по образцу RevealSecret.
    pub password: Option<String>,
}

/// Сколько молчания сервера считаем обрывом связи во время провижининга домена.
///
/// Обычных для FastPanel CLI 45s тут мало: `certificates create-le` уходит в
/// ACME-валидацию и молчит минутами, да и сам provision между шагами простаивает
/// (до ~15s на проверку DNS плюс запрос `/auth/me`) — russh рвал бы живую сессию
/// задолго до 300s exec-таймаута команды. Берём 300s, чтобы предел задавал exec,
/// а не inactivity.
const PROVISION_SESSION_TIMEOUT: Duration = Duration::from_secs(300);
/// Сколько раз перепроверяем DNS перед выпуском SSL и с какой паузой между
/// попытками (~15s суммарно): свежая A-запись нередко «доезжает» до резолвера
/// за эти секунды, а ждать дольше внутри provision смысла нет — Let's Encrypt
/// всё равно проверяет домен со своей стороны.
const SSL_DNS_ATTEMPTS: u32 = 5;
const SSL_DNS_RETRY_DELAY: Duration = Duration::from_secs(3);
/// Сколько последних строк вывода certbot/FastPanel отдавать во фронт как
/// причину неудачного выпуска SSL.
const SSL_ERROR_TAIL_LINES: usize = 20;

/// Ошибка создания БД — без пароля этой БД.
///
/// `create_database` в fallback-ветке кладёт в текст ошибки вывод
/// `mysql -e "... IDENTIFIED BY '<пароль>'"`, а mysql в сообщении об ошибке
/// повторяет исходный запрос — то есть пароль. Поэтому `SshError::Session`
/// (единственный вариант, который несёт вывод команды) схлопываем в
/// обезличенный текст; остальные варианты вывода не содержат и идут как есть.
fn db_error(e: SshError) -> CommandError {
    match e {
        SshError::Session(m) if m == "exec timeout" => {
            CommandError::Api("database creation timed out".into())
        }
        SshError::Session(_) => CommandError::Api("database creation failed on the server".into()),
        other => CommandError::from(other),
    }
}

/// Параметры провижининга, вычитанные из локального кэша до открытия SSH.
struct ProvisionPlan<'a> {
    domain_id: &'a str,
    domain_name: &'a str,
    /// IP сервера — он же ожидаемый ответ DNS перед выпуском SSL.
    host: &'a str,
    php_version: &'a str,
    site_user_existing: Option<String>,
    site_only: bool,
    with_db: bool,
}

/// Что провижининг успел сделать внутри уже открытой сессии.
struct ProvisionSteps {
    site_user: String,
    site_path: String,
    steps: Vec<&'static str>,
    ssl_issued: Option<bool>,
    ssl_error: Option<String>,
    db: Option<DbInfoOut>,
}

/// Шаги провижининга внутри уже открытой сессии.
///
/// Вынесено отдельно ровно затем же, зачем `run_fastpanel_install_steps`:
/// вызывающий закрывает сессию один раз на любом пути выхода. Каждый `?`
/// здесь — от `create_site` до `create_database` — иначе утекал бы соединением.
async fn run_provision_steps(
    app: &AppHandle,
    session: &mut SshSession,
    api: &ApiClient,
    plan: &ProvisionPlan<'_>,
) -> Result<ProvisionSteps, CommandError> {
    let domain_id = plan.domain_id;
    let domain_name = plan.domain_name;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "fastpanel_path", "domain_id": domain_id }),
    );
    let fp_path = fastpanel::get_fastpanel_path(session, None)
        .await?
        .ok_or_else(|| CommandError::Api("fastpanel binary not found on server".into()))?;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "firewall_preflight", "domain_id": domain_id }),
    );
    let ports = fastpanel::ensure_ports_open(session, &[80, 443]).await?;
    if !ports.success {
        tracing::warn!(target: "provision", "firewall preflight: {:?}", ports.error);
    }

    let CreateSiteResult {
        site_user,
        site_path,
        ..
    } = if let Some(ref u) = plan.site_user_existing {
        if fastpanel::site_exists(session, u, domain_name).await? {
            CreateSiteResult {
                site_user: u.clone(),
                site_path: format!("/var/www/{u}/data/www/{domain_name}"),
                output: "already exists".into(),
            }
        } else {
            fastpanel::create_site(session, &fp_path, domain_name, plan.php_version).await?
        }
    } else {
        fastpanel::create_site(session, &fp_path, domain_name, plan.php_version).await?
    };

    let mut done = ProvisionSteps {
        site_user,
        site_path,
        steps: vec!["ssh", "create_site"],
        ssl_issued: None,
        ssl_error: None,
        db: None,
    };

    if !plan.site_only {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "ftp", "domain_id": domain_id }),
        );
        let _ftp = fastpanel::create_ftp_account(session, &fp_path, domain_name).await?;
        done.steps.push("ftp");

        // SSL. Ни один путь этого блока не возвращает Err: сайт и FTP уже
        // созданы, и провалить из-за них весь provision значило бы отрапортовать
        // неудачу об удавшейся работе, а на повторе заново прогонять create_site.
        // Причина неудачи уезжает во фронт в `ssl_error`.
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "ssl_dns_check", "domain_id": domain_id }),
        );
        let resolves = fastpanel::dns_resolves_to(
            domain_name,
            plan.host,
            SSL_DNS_ATTEMPTS,
            SSL_DNS_RETRY_DELAY,
        )
        .await;
        if !resolves {
            // Домен ещё не смотрит на сервер: Let's Encrypt не пройдёт HTTP-01,
            // и дёргать его сейчас — только жечь rate limit.
            let _ = app.emit(
                "provision:progress",
                serde_json::json!({ "step": "ssl_skipped_dns", "domain_id": domain_id }),
            );
            done.ssl_issued = Some(false);
            done.ssl_error = Some("dns does not resolve to server ip yet".into());
        } else {
            // Почта для LE — почта самого аккаунта. Сбой `/auth/me` не должен
            // валить provision: это отдельный сетевой вызов, к состоянию сервера
            // отношения не имеющий.
            match api.me().await {
                Err(e) => {
                    tracing::warn!(target: "provision", "no account email for LE: {e}");
                    let _ = app.emit(
                        "provision:progress",
                        serde_json::json!({ "step": "ssl_skipped_no_email", "domain_id": domain_id }),
                    );
                    done.ssl_issued = Some(false);
                    done.ssl_error = Some(format!("could not read account email for LE: {e}"));
                }
                Ok(me) => {
                    let _ = app.emit(
                        "provision:progress",
                        serde_json::json!({ "step": "ssl_issue", "domain_id": domain_id }),
                    );
                    match fastpanel::issue_ssl_certificate(
                        session,
                        &fp_path,
                        domain_name,
                        &me.email,
                    )
                    .await
                    {
                        Ok(_) => {
                            done.ssl_issued = Some(true);
                            done.steps.push("ssl");
                        }
                        Err(e) => {
                            tracing::warn!(target: "provision", "ssl issue failed: {e}");
                            done.ssl_issued = Some(false);
                            done.ssl_error = Some(tail_lines(&e.to_string(), SSL_ERROR_TAIL_LINES));
                        }
                    }
                }
            }
        }
    }

    // БД — независимый opt-in, а не часть «полного» набора: её просят явным
    // флагом, в том числе вместе с `site_only`, и молча игнорировать явную
    // просьбу хуже, чем создать лишнюю базу.
    if plan.with_db {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "db", "domain_id": domain_id }),
        );
        // `output` из CreateDbResult отбрасываем здесь же: в fallback-ветке это
        // вывод mysql, в котором повторён CREATE USER ... IDENTIFIED BY.
        let CreateDbResult {
            db_name,
            db_user,
            db_password,
            ..
        } = fastpanel::create_database(session, &fp_path, domain_name, None, None)
            .await
            .map_err(db_error)?;
        done.steps.push("db");
        done.db = Some(DbInfoOut {
            db_name,
            db_user,
            db_password,
        });
    }

    Ok(done)
}

pub async fn run_provision_domain(
    app: &AppHandle,
    user_id: &str,
    domain_id: &str,
    site_only: bool,
    with_db: bool,
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
    let site_user_existing = domain_row.get("site_user").and_then(json_str);

    // Всё нужное из кэша забираем до SSH: держать SQLCipher открытым весь
    // provision (выпуск LE — минуты) незачем.
    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());
    drop(conn);

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": "ssh_connect", "domain_id": domain_id }),
    );

    let mut session = ssh_connect_session_with_timeout(
        app,
        &host,
        port,
        &ssh_user,
        &password,
        PROVISION_SESSION_TIMEOUT,
    )
    .await?;

    let plan = ProvisionPlan {
        domain_id,
        domain_name: &domain_name,
        host: &host,
        php_version: &php_version,
        site_user_existing,
        site_only,
        with_db,
    };
    let stepped = run_provision_steps(app, &mut session, api, &plan).await;
    let _ = session.disconnect().await;
    let done = stepped?;

    // metadata без секретов: ни пароля БД, ни FTP, ни текста ssl_error (это
    // вывод certbot, и он всё равно длинный). Redaction guard в http.rs —
    // debug_assert, в release его нет, так что чистота обеспечивается здесь.
    //
    // Аудит — best-effort, как и в install_fastpanel, и по той же причине:
    // при `with_db` пароль БД существует только в этом ответе, и `?` здесь
    // потерял бы его навсегда из-за сетевого сбоя на последнем шаге. Не
    // превращать обратно в `?`. Незаписанный аудит не замалчиваем: помимо
    // варнинга шлём тот же `provision:progress`, что и остальные шаги.
    if let Err(e) = api
        .audit_log(
            "device.action.complete",
            Some("domain"),
            Some(domain_id),
            device_id,
            Some(serde_json::json!({
                "steps": done.steps,
                "domain_name": domain_name,
                "server_id": server_id,
                "site_only": site_only,
                "ssl_issued": done.ssl_issued,
            })),
        )
        .await
    {
        tracing::warn!(target: "provision", "audit log for provision failed: {e}");
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "audit_failed", "domain_id": domain_id }),
        );
    }

    Ok(ProvisionResultOut {
        domain_id: domain_id.to_string(),
        site_user: done.site_user,
        site_path: done.site_path,
        ssl_issued: done.ssl_issued,
        ssl_error: done.ssl_error,
        db: done.db,
    })
}

/// `with_db` — `Option` ради обратной совместимости: фронт до Task 9 этот
/// аргумент не шлёт, и без `Option` его вызовы стали бы ошибкой десериализации.
#[tauri::command]
pub async fn provision_domain(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    site_only: bool,
    with_db: Option<bool>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<ProvisionResultOut, CommandError> {
    let cache_path = cache_path(&handle)?;
    run_provision_domain(
        &app,
        &user_id,
        &domain_id,
        site_only,
        with_db.unwrap_or(false),
        &cache_path,
        &api,
    )
    .await
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
        // Массовый прогон — без БД: пароли БД возвращаются только в ответе на
        // одиночный provision, а bulk отдаёт наружу лишь ключ идемпотентности.
        run_provision_domain(&app, &user_id, did, false, false, &cache_path, &api).await?;
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

    // `create_database` кладёт в текст ошибки вывод mysql, а тот повторяет
    // `CREATE USER ... IDENTIFIED BY '<пароль>'`. Наружу пароль уйти не должен.
    #[test]
    fn db_error_drops_command_output_with_the_password() {
        let leaky = "ERROR 1064 at line 1: near \"CREATE USER 'u'@'localhost' \
                     IDENTIFIED BY 'sup3rSecret'\"";
        let e = db_error(SshError::Session(leaky.into()));
        assert_eq!(e.to_string(), "api: database creation failed on the server");
        assert!(!e.to_string().contains("sup3rSecret"));
    }

    #[test]
    fn db_error_names_the_timeout() {
        let e = db_error(SshError::Session("exec timeout".into()));
        assert_eq!(e.to_string(), "api: database creation timed out");
    }

    // Варианты без вывода команды диагностику терять не должны.
    #[test]
    fn db_error_passes_through_errors_without_command_output() {
        assert_eq!(db_error(SshError::Auth).to_string(), "ssh: auth failed");
        assert_eq!(
            db_error(SshError::Connect("refused".into())).to_string(),
            "ssh: connect: refused"
        );
    }

    #[test]
    fn provision_result_omits_empty_optionals() {
        let r = ProvisionResultOut {
            domain_id: "1".into(),
            site_user: "u".into(),
            site_path: "/p".into(),
            ssl_issued: None,
            ssl_error: None,
            db: None,
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(!j.contains("ssl_issued"));
        assert!(!j.contains("ssl_error"));
        assert!(!j.contains("\"db\""));
    }

    #[test]
    fn provision_result_includes_db_when_present() {
        let r = ProvisionResultOut {
            domain_id: "1".into(),
            site_user: "u".into(),
            site_path: "/p".into(),
            ssl_issued: Some(true),
            ssl_error: None,
            db: Some(DbInfoOut {
                db_name: "d".into(),
                db_user: "du".into(),
                db_password: "dp".into(),
            }),
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains("ssl_issued"));
        assert!(j.contains("db_name"));
    }
}
