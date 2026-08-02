//! FastPanel operations over SSH (ported from legacy `fastpanel_client.py`).

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use dryoc::rng::randombytes_buf;
use regex::Regex;
use serde::Serialize;
use shell_escape::escape;
use tokio::time::sleep;

use crate::ssh::client::{SshError, SshSession};

pub const FASTPANEL_FALLBACK_PATH: &str = "/usr/local/fastpanel2/fastpanel";

#[derive(Serialize)]
pub struct CreateSiteResult {
    pub site_user: String,
    pub site_path: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct CreateFtpResult {
    pub ftp_user: String,
    pub ftp_password: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct CreateDbResult {
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    pub output: String,
}

#[derive(Serialize)]
pub struct SslInfo {
    pub has_certificate: bool,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub issuer: Option<String>,
    pub is_letsencrypt: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct SiteInfo {
    pub domain_name: String,
    pub site_user: Option<String>,
    pub site_path: Option<String>,
    pub php_version: Option<String>,
}

#[derive(Serialize)]
pub struct EnsurePortsResult {
    pub success: bool,
    pub firewall: Option<String>,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn q(s: &str) -> String {
    escape(Cow::Borrowed(s)).into_owned()
}

/// Ошибка команды, в argv которой был сгенерированный пароль.
///
/// Такие утилиты (FastPanel CLI, mysql) при ошибке повторяют полученный запрос
/// или usage вместе с аргументами — то есть кладут пароль прямо в текст. Наружу
/// поэтому уходит только код возврата; сам пароль в этот момент уже может быть
/// живым (mysql выполняет `CREATE USER` до `GRANT`, и падение на втором
/// оставляет созданного пользователя с этим паролем).
fn opaque_exit(step: &str, code: i32) -> SshError {
    SshError::Session(format!(
        "{step} exit {code} (output withheld: it echoes the generated password)"
    ))
}

pub async fn get_fastpanel_path(
    s: &mut SshSession,
    override_path: Option<&str>,
) -> Result<Option<String>, SshError> {
    if let Some(p) = override_path {
        return Ok(Some(p.to_string()));
    }
    let (code, out) = s.exec("which fastpanel", Duration::from_secs(30), false).await?;
    if code == 0 {
        let line = out.trim().lines().next().unwrap_or("").trim();
        if !line.is_empty() {
            return Ok(Some(line.to_string()));
        }
    }
    let (c2, _) = s
        .exec(
            &format!("test -x {}", q(FASTPANEL_FALLBACK_PATH)),
            Duration::from_secs(15),
            false,
        )
        .await?;
    if c2 == 0 {
        return Ok(Some(FASTPANEL_FALLBACK_PATH.to_string()));
    }
    Ok(None)
}

pub fn make_site_user(domain: &str) -> String {
    let slug = domain
        .split_once('.')
        .map(|(a, _)| a)
        .unwrap_or(domain)
        .replace('-', "_");
    format!("{}_usr", &slug[..slug.len().min(12)])
}

pub fn make_ftp_login(domain: &str) -> String {
    let slug = domain
        .split_once('.')
        .map(|(a, _)| a)
        .unwrap_or(domain)
        .replace('-', "_");
    format!("ftp_{slug}")
}

pub fn generate_password(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let buf = randombytes_buf(len);
    buf.iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

pub async fn site_exists(
    s: &mut SshSession,
    site_user: &str,
    domain: &str,
) -> Result<bool, SshError> {
    let path = format!("/var/www/{site_user}/data/www/{domain}");
    let (code, _) = s
        .exec(&format!("test -d {}", q(&path)), Duration::from_secs(30), false)
        .await?;
    Ok(code == 0)
}

pub async fn cert_exists(s: &mut SshSession, domain: &str) -> Result<bool, SshError> {
    let path = format!("/etc/letsencrypt/live/{domain}/fullchain.pem");
    let (code, _) = s
        .exec(&format!("test -f {}", q(&path)), Duration::from_secs(30), false)
        .await?;
    Ok(code == 0)
}

pub async fn create_site(
    s: &mut SshSession,
    fp_path: &str,
    domain: &str,
    php_version: &str,
) -> Result<CreateSiteResult, SshError> {
    let site_user = make_site_user(domain);
    let cmd = format!(
        "{} sites create --server-name={} --owner={} --create-user --php-version={}",
        q(fp_path),
        q(domain),
        q(&site_user),
        q(php_version),
    );
    let (code, output) = s.exec(&cmd, Duration::from_secs(120), false).await?;
    if code != 0 {
        return Err(SshError::Session(format!(
            "create_site exit {code}: {output}"
        )));
    }
    if !site_exists(s, &site_user, domain).await? {
        return Err(SshError::Session("site directory check failed".into()));
    }
    Ok(CreateSiteResult {
        site_user: site_user.clone(),
        site_path: format!("/var/www/{site_user}/data/www/{domain}"),
        output,
    })
}

pub async fn create_ftp_account(
    s: &mut SshSession,
    fp_path: &str,
    domain: &str,
) -> Result<CreateFtpResult, SshError> {
    let ftp_user = make_ftp_login(domain);
    let password = generate_password(14);
    let cmd = format!(
        "{} ftp_account create --login={} --password={} --site={}",
        q(fp_path),
        q(&ftp_user),
        q(&password),
        q(domain),
    );
    let (code, output) = s.exec(&cmd, Duration::from_secs(120), false).await?;
    if code != 0 {
        return Err(opaque_exit("create_ftp_account", code));
    }
    Ok(CreateFtpResult {
        ftp_user,
        ftp_password: password,
        output,
    })
}

pub async fn issue_ssl_certificate(
    s: &mut SshSession,
    fp_path: &str,
    domain: &str,
    email: &str,
) -> Result<String, SshError> {
    let cmd = format!(
        "{} certificates create-le --server-name={} --email={}",
        q(fp_path),
        q(domain),
        q(email),
    );
    let (code, output) = s.exec(&cmd, Duration::from_secs(300), false).await?;
    if code != 0 {
        return Err(SshError::Session(format!("issue_ssl exit {code}: {output}")));
    }
    sleep(Duration::from_secs(5)).await;
    if !cert_exists(s, domain).await? {
        return Err(SshError::Session("SSL certificate file check failed".into()));
    }
    Ok(output)
}

fn safe_mysql_name(value: &str, fallback: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_matches('_').to_lowercase();
    let base = if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    };
    base.chars().take(32).collect()
}

pub async fn create_database(
    s: &mut SshSession,
    fp_path: &str,
    domain: &str,
    db_name: Option<&str>,
    db_user: Option<&str>,
) -> Result<CreateDbResult, SshError> {
    let slug = domain.split_once('.').map(|(a, _)| a).unwrap_or(domain);
    let database_name = safe_mysql_name(
        db_name.unwrap_or(&format!("{slug}_db")),
        "site_db",
    );
    let database_user = safe_mysql_name(db_user.unwrap_or(&format!("{slug}_usr")), "site_usr");
    let database_password = generate_password(18);

    let fp_cmd = format!(
        "{} database create --name={} --user={} --password={}",
        q(fp_path),
        q(&database_name),
        q(&database_user),
        q(&database_password),
    );
    let (code, out) = s.exec(&fp_cmd, Duration::from_secs(60), false).await?;
    if code == 0 {
        return Ok(CreateDbResult {
            db_name: database_name,
            db_user: database_user,
            db_password: database_password,
            output: out,
        });
    }

    let sql = format!(
        "CREATE DATABASE IF NOT EXISTS `{database_name}`;\
         CREATE USER IF NOT EXISTS '{database_user}'@'localhost' IDENTIFIED BY '{database_password}';\
         GRANT ALL PRIVILEGES ON `{database_name}`.* TO '{database_user}'@'localhost';\
         FLUSH PRIVILEGES;"
    );
    let fallback_cmd = format!("mysql -e {}", q(&sql));
    let (fb_code, fb_out) = s
        .exec(&fallback_cmd, Duration::from_secs(60), false)
        .await?;
    if fb_code != 0 {
        // Ни `out` (вывод fastpanel с `--password=` в argv), ни `fb_out` (mysql
        // повторяет в ошибке весь запрос, включая IDENTIFIED BY) наружу нельзя.
        return Err(opaque_exit("create_database", fb_code));
    }
    Ok(CreateDbResult {
        db_name: database_name,
        db_user: database_user,
        db_password: database_password,
        output: if fb_out.is_empty() { out } else { fb_out },
    })
}

pub async fn revoke_ssl_certificate(
    s: &mut SshSession,
    fp_path: &str,
    domain: &str,
) -> Result<String, SshError> {
    let rm_cmd = format!(
        "rm -rf /etc/letsencrypt/live/{} /etc/letsencrypt/archive/{} /etc/letsencrypt/renewal/{}.conf",
        q(domain),
        q(domain),
        q(domain),
    );
    let fp_cmd = format!(
        "{} certificates remove --server-name={} || true",
        q(fp_path),
        q(domain),
    );
    let reload_cmd = format!(
        "{} sites regenerate-config --server-name={} || (nginx -t && systemctl reload nginx)",
        q(fp_path),
        q(domain),
    );
    let (_, out1) = s.exec(&fp_cmd, Duration::from_secs(120), false).await?;
    let (code2, out2) = s.exec(&rm_cmd, Duration::from_secs(60), false).await?;
    let (code3, out3) = s.exec(&reload_cmd, Duration::from_secs(120), false).await?;
    if code2 != 0 || code3 != 0 {
        return Err(SshError::Session(
            format!("{out1}\n{out2}\n{out3}").trim().to_string(),
        ));
    }
    Ok(format!("{out1}\n{out2}\n{out3}").trim().to_string())
}

pub async fn read_ssl_info(s: &mut SshSession, domain: &str) -> Result<SslInfo, SshError> {
    if !cert_exists(s, domain).await? {
        return Ok(SslInfo {
            has_certificate: false,
            expires_at: None,
            issuer: None,
            is_letsencrypt: false,
            error: None,
        });
    }
    let cert_path = format!("/etc/letsencrypt/live/{domain}/fullchain.pem");
    let cmd = format!("openssl x509 -in {} -noout -enddate -issuer -subject", q(&cert_path));
    let (code, out) = s.exec(&cmd, Duration::from_secs(30), false).await?;
    if code != 0 {
        return Ok(SslInfo {
            has_certificate: true,
            expires_at: None,
            issuer: None,
            is_letsencrypt: false,
            error: Some(out),
        });
    }
    let mut expires_at: Option<chrono::DateTime<chrono::Utc>> = None;
    let mut issuer: Option<String> = None;
    for line in out.lines() {
        let line = line.trim();
        if let Some(raw) = line.strip_prefix("notAfter=") {
            let raw = raw.trim();
            if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(raw, "%b %e %H:%M:%S %Y GMT")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(raw, "%b %d %H:%M:%S %Y GMT"))
            {
                expires_at = Some(ndt.and_utc());
            }
        } else if let Some(i) = line.strip_prefix("issuer=") {
            issuer = Some(i.trim().chars().take(64).collect());
        }
    }
    let is_le = issuer
        .as_ref()
        .map(|i| i.to_lowercase().contains("let's encrypt"))
        .unwrap_or(false);
    Ok(SslInfo {
        has_certificate: true,
        expires_at,
        issuer,
        is_letsencrypt: is_le,
        error: None,
    })
}

#[derive(Serialize)]
pub struct NginxReadResult {
    pub success: bool,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn read_nginx_override(
    s: &mut SshSession,
    site_user: &str,
    domain: &str,
) -> Result<NginxReadResult, SshError> {
    let path = format!("/var/www/{site_user}/data/nginx-includes/{domain}.conf");
    let (code, out) = s
        .exec(&format!("cat {}", q(&path)), Duration::from_secs(30), false)
        .await?;
    if code != 0 {
        return Ok(NginxReadResult {
            success: false,
            snippet: String::new(),
            error: Some(out),
        });
    }
    Ok(NginxReadResult {
        success: true,
        snippet: out,
        error: None,
    })
}

fn render_nginx_snippet(domain: &str, snippet: &str, presets: &serde_json::Value) -> String {
    let mut blocks: Vec<String> = Vec::new();
    if presets.get("force_https").and_then(|v| v.as_bool()) == Some(true) {
        blocks.push(format!(
            "if ($scheme = http) {{\n    return 301 https://{domain}$request_uri;\n}}"
        ));
    }
    if presets.get("www_redirect").and_then(|v| v.as_bool()) == Some(true) {
        blocks.push(format!(
            "if ($host = \"www.{domain}\") {{\n    return 301 https://{domain}$request_uri;\n}}"
        ));
    }
    if presets.get("custom_404").and_then(|v| v.as_bool()) == Some(true) {
        blocks.push("error_page 404 /404.html;".into());
    }
    if presets.get("basic_auth").and_then(|v| v.as_bool()) == Some(true) {
        blocks.push("auth_basic \"Restricted\";\nauth_basic_user_file /etc/nginx/.htpasswd;".into());
    }
    if !snippet.trim().is_empty() {
        blocks.push(snippet.trim().to_string());
    }
    let mut out = blocks.join("\n\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

#[derive(Serialize)]
pub struct ApplyNginxResult {
    pub success: bool,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn apply_nginx_override(
    s: &mut SshSession,
    fp_path: &str,
    domain: &str,
    site_user: &str,
    snippet: &str,
    presets: Option<serde_json::Value>,
) -> Result<ApplyNginxResult, SshError> {
    let presets = presets.unwrap_or(serde_json::json!({}));
    let rendered = render_nginx_snippet(domain, snippet, &presets);
    let include_dir = format!("/var/www/{site_user}/data/nginx-includes");
    let include_path = format!("{include_dir}/{domain}.conf");
    let backup_path = format!("{include_path}.bak");
    let escaped = rendered
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$");
    let cmd = format!(
        "mkdir -p {} && cp {} {} 2>/dev/null || true && printf \"%s\" \"{}\" > {} && nginx -t",
        q(&include_dir),
        q(&include_path),
        q(&backup_path),
        escaped,
        q(&include_path),
    );
    let (code, out) = s.exec(&cmd, Duration::from_secs(60), false).await?;
    if code != 0 {
        let rollback_cmd = format!(
            "if [ -f {} ]; then mv {} {}; else rm -f {}; fi",
            q(&backup_path),
            q(&backup_path),
            q(&include_path),
            q(&include_path),
        );
        let _ = s.exec(&rollback_cmd, Duration::from_secs(20), false).await;
        return Ok(ApplyNginxResult {
            success: false,
            snippet: rendered,
            error: Some(out),
        });
    }
    let reload_cmd = format!(
        "{} sites regenerate-config --server-name={} || systemctl reload nginx",
        q(fp_path),
        q(domain),
    );
    let (rc, reload_out) = s.exec(&reload_cmd, Duration::from_secs(60), false).await?;
    if rc != 0 {
        return Ok(ApplyNginxResult {
            success: false,
            snippet: rendered,
            error: Some(reload_out),
        });
    }
    Ok(ApplyNginxResult {
        success: true,
        snippet: rendered,
        error: None,
    })
}

async fn detect_firewall(s: &mut SshSession) -> Result<Option<&'static str>, SshError> {
    for (bin, name) in [("ufw", "ufw"), ("firewall-cmd", "firewalld")] {
        let (code, _) = s
            .exec(&format!("command -v {}", q(bin)), Duration::from_secs(15), false)
            .await?;
        if code == 0 {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

pub async fn ensure_ports_open(
    s: &mut SshSession,
    ports: &[u16],
) -> Result<EnsurePortsResult, SshError> {
    let firewall = detect_firewall(s).await?;
    let Some(fw) = firewall else {
        return Ok(EnsurePortsResult {
            success: true,
            firewall: None,
            output: "no firewall detected".into(),
            error: None,
        });
    };
    if fw == "ufw" {
        let mut outputs = Vec::new();
        for port in ports {
            let (code, out) = s
                .exec(&format!("ufw allow {port}/tcp"), Duration::from_secs(30), false)
                .await?;
            outputs.push(if out.is_empty() {
                format!("ufw allow {port}/tcp -> {code}")
            } else {
                out
            });
            if code != 0 {
                return Ok(EnsurePortsResult {
                    success: false,
                    firewall: Some(fw.to_string()),
                    output: outputs.join("\n"),
                    error: Some("ufw failed".into()),
                });
            }
        }
        return Ok(EnsurePortsResult {
            success: true,
            firewall: Some(fw.to_string()),
            output: outputs.join("\n"),
            error: None,
        });
    }
    let mut outputs = Vec::new();
    for port in ports {
        let (code, out) = s
            .exec(
                &format!("firewall-cmd --permanent --add-port={port}/tcp"),
                Duration::from_secs(30),
                false,
            )
            .await?;
        outputs.push(if out.is_empty() {
            format!("firewalld add-port {port}/tcp -> {code}")
        } else {
            out.clone()
        });
        if code != 0 && !out.contains("ALREADY_ENABLED") {
            return Ok(EnsurePortsResult {
                success: false,
                firewall: Some(fw.to_string()),
                output: outputs.join("\n"),
                error: Some("firewalld failed".into()),
            });
        }
    }
    let (_, _) = s
        .exec("firewall-cmd --reload", Duration::from_secs(60), false)
        .await?;
    Ok(EnsurePortsResult {
        success: true,
        firewall: Some(fw.to_string()),
        output: outputs.join("\n"),
        error: None,
    })
}

pub async fn dns_resolves_to(
    domain: &str,
    expected_ip: &str,
    attempts: u32,
    delay: Duration,
) -> bool {
    let expected = expected_ip.trim();
    for i in 0..attempts {
        if let Ok(it) = tokio::net::lookup_host(format!("{domain}:0")).await {
            let ips: HashSet<String> = it.map(|a| a.ip().to_string()).collect();
            if ips.contains(expected) {
                return true;
            }
        }
        if i + 1 < attempts {
            sleep(delay).await;
        }
    }
    false
}

fn php_version_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\d+(?:\.\d+){0,2}").unwrap())
}

fn coerce_php_version(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    let m = php_version_re().find(raw)?;
    Some(m.as_str().to_string())
}

fn coerce_str(value: Option<&str>, max_len: usize) -> Option<String> {
    let s = value?.trim();
    if s.is_empty() {
        return None;
    }
    Some(s.chars().take(max_len).collect())
}

fn first_non_empty<'a>(candidates: &[Option<&'a str>]) -> Option<&'a str> {
    candidates.iter().flatten().find(|s| !s.trim().is_empty()).copied()
}

fn normalize_site_row(raw: &serde_json::Value) -> Option<SiteInfo> {
    let domain = raw
        .get("domain_name")
        .or(raw.get("domain"))
        .or(raw.get("server_name"))
        .or(raw.get("name"))
        .or(raw.get("site"))
        .and_then(|v| v.as_str())?;
    let domain_str = domain.trim();
    if domain_str.is_empty() {
        return None;
    }
    let owner = raw.get("owner").and_then(|v| v.as_object());
    let raw_site_user = first_non_empty(&[
        raw.get("site_user").and_then(|v| v.as_str()),
        raw.get("user").and_then(|v| v.as_str()),
        owner.and_then(|o| o.get("username")).and_then(|v| v.as_str()),
        owner.and_then(|o| o.get("login")).and_then(|v| v.as_str()),
        owner.and_then(|o| o.get("name")).and_then(|v| v.as_str()),
        raw.get("owner").and_then(|v| v.as_str()),
    ]);
    let raw_site_path = first_non_empty(&[
        raw.get("site_path").and_then(|v| v.as_str()),
        raw.get("path").and_then(|v| v.as_str()),
        raw.get("www_path").and_then(|v| v.as_str()),
    ])
    .map(|s| s.to_string())
    .or_else(|| {
        let home = owner?.get("home_dir")?.as_str()?;
        let h = home.trim();
        if h.is_empty() {
            return None;
        }
        Some(format!("{}/www/{domain_str}", h.trim_end_matches('/')))
    });
    let php_raw = coerce_php_version(
        raw.get("php_version")
            .or(raw.get("php"))
            .and_then(|v| v.as_str()),
    );
    let php_version = coerce_str(php_raw.as_deref(), 16);
    Some(SiteInfo {
        domain_name: domain_str.chars().take(255).collect(),
        site_user: coerce_str(raw_site_user, 64),
        site_path: raw_site_path.and_then(|s| coerce_str(Some(&s), 255)),
        php_version,
    })
}

fn parse_sites_from_text_table(output: &str) -> Vec<SiteInfo> {
    let header = Regex::new(r"\b(domain|site|owner|php)\b").unwrap();
    let sep = Regex::new(r"\s{2,}|\t+|\|").unwrap();
    let mut sites = Vec::new();
    for ln in output.lines() {
        let line = ln.trim();
        if line.is_empty() || header.is_match(line) {
            continue;
        }
        if line.chars().all(|c| "-+| ".contains(c)) {
            continue;
        }
        let chunks: Vec<&str> = sep
            .split(line)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if chunks.is_empty() {
            continue;
        }
        let domain = chunks[0];
        if !domain.contains('.') {
            continue;
        }
        let site_user = chunks.get(1).and_then(|s| coerce_str(Some(s), 64));
        let site_path = chunks.get(2).and_then(|s| coerce_str(Some(s), 255));
        let php_version = chunks
            .get(3)
            .and_then(|s| coerce_php_version(Some(s)))
            .and_then(|s| coerce_str(Some(&s), 16));
        sites.push(SiteInfo {
            domain_name: domain.chars().take(255).collect(),
            site_user,
            site_path,
            php_version,
        });
    }
    sites
}

fn parse_sites_from_paths(output: &str) -> Vec<SiteInfo> {
    let re = Regex::new(r"^/var/www/([^/]+)/data/www/([^/]+)$").unwrap();
    let mut rows = Vec::new();
    for ln in output.lines() {
        let path = ln.trim();
        if !path.contains("/data/www/") {
            continue;
        }
        if let Some(c) = re.captures(path) {
            rows.push(SiteInfo {
                domain_name: c.get(2).unwrap().as_str().to_string(),
                site_user: Some(c.get(1).unwrap().as_str().to_string()),
                site_path: Some(path.to_string()),
                php_version: None,
            });
        }
    }
    rows
}

pub async fn list_sites(s: &mut SshSession, fp_path: Option<&str>) -> Result<Vec<SiteInfo>, SshError> {
    if let Some(fp) = fp_path {
        let cmd = format!("{} sites list --json", q(fp));
        let (code, out) = s.exec(&cmd, Duration::from_secs(15), false).await?;
        if code == 0 && !out.trim().is_empty() {
            if let Ok(mut raw) = serde_json::from_str::<serde_json::Value>(&out) {
                if let Some(obj) = raw.as_object_mut() {
                    if let Some(r) = obj.get("result").cloned() {
                        raw = r;
                    } else if let Some(r) = obj.get("sites").cloned() {
                        raw = r;
                    }
                }
                if let Some(arr) = raw.as_array() {
                    let mut rows = Vec::new();
                    for item in arr {
                        if let Some(n) = normalize_site_row(item) {
                            rows.push(n);
                        }
                    }
                    if !rows.is_empty() {
                        return Ok(rows);
                    }
                }
            }
        }
        let cmd2 = format!("{} sites list", q(fp));
        let (c2, o2) = s.exec(&cmd2, Duration::from_secs(15), false).await?;
        if c2 == 0 && !o2.trim().is_empty() {
            let rows = parse_sites_from_text_table(&o2);
            if !rows.is_empty() {
                return Ok(rows);
            }
        }
    }
    let fs_cmd = "python3 -c \"import glob; [print(p) for p in glob.glob('/var/www/*/data/www/*')]\"";
    let (c3, o3) = s.exec(fs_cmd, Duration::from_secs(15), false).await?;
    if c3 == 0 && !o3.trim().is_empty() {
        return Ok(parse_sites_from_paths(&o3));
    }
    Ok(vec![])
}

/// Build the shell command for `create_site` (for tests).
pub fn build_create_site_cmd(fp_path: &str, domain: &str, site_user: &str, php_version: &str) -> String {
    format!(
        "{} sites create --server-name={} --owner={} --create-user --php-version={}",
        q(fp_path),
        q(domain),
        q(site_user),
        q(php_version),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_site_cmd_quoting() {
        let cmd = build_create_site_cmd(
            "/usr/local/fastpanel2/fastpanel",
            "example.com",
            "ex_usr",
            "8.1",
        );
        assert!(cmd.contains("sites create"));
        assert!(cmd.contains("example.com"));
        assert!(cmd.contains("ex_usr"));
        assert!(cmd.contains("8.1"));
    }

    #[test]
    fn make_site_user_slug() {
        assert_eq!(make_site_user("foo-bar.example.com"), "foo_bar_usr");
    }

    // Вывод этих команд повторяет argv (а там `--password=`) или сам SQL с
    // IDENTIFIED BY. Наружу должен уходить только код возврата.
    #[test]
    fn opaque_exit_keeps_only_the_exit_code() {
        let e = opaque_exit("create_database", 1);
        let msg = e.to_string();
        assert!(msg.contains("create_database"), "{msg}");
        assert!(msg.contains("exit 1"), "{msg}");
        assert!(msg.contains("withheld"), "{msg}");
    }

    // Пароль генерируется здесь же — убеждаемся, что ему просто некуда попасть
    // в текст ошибки.
    #[test]
    fn opaque_exit_has_no_room_for_command_output() {
        let pw = generate_password(18);
        let e = opaque_exit("create_ftp_account", 2);
        assert!(!e.to_string().contains(&pw));
    }
}
