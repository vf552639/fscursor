//! FastPanel install-over-SSH pipeline (порт легаси `fastpanel_task`).

/// Команда установки FastPanel (из легаси `INSTALL_CMD`).
pub const INSTALL_CMD: &str =
    "wget https://repo.fastpanel.direct/install_fastpanel.sh -O - | bash -";

/// Команда обновления системы под семейство ОС (порт `_update_cmd`).
///
/// Легаси использует `re.search(r"cent|rhel|rocky|alma|fedora", os_name, re.I)` —
/// то есть простое вхождение подстроки "cent" (а не "centos"), без границ
/// слова. Порт сохраняет это дословно: `os_name` с пробелом ("Cent OS 7")
/// всё ещё матчится, как и в легаси.
pub fn update_command(os: &str) -> String {
    let o = os.to_ascii_lowercase();
    if o.contains("cent")
        || o.contains("rhel")
        || o.contains("rocky")
        || o.contains("alma")
        || o.contains("fedora")
    {
        "yum -y update".to_string()
    } else {
        "DEBIAN_FRONTEND=noninteractive apt-get update && \
         DEBIAN_FRONTEND=noninteractive apt-get -y upgrade"
            .to_string()
    }
}

/// Разобранные креды из вывода инсталлятора.
#[derive(Debug, Default, PartialEq)]
pub struct FpCredentials {
    pub url: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
}

/// Достать URL панели / логин / пароль из stdout инсталлятора (порт `_parse_credentials`).
///
/// Легаси-регексы:
/// - URL: `r"https?://[^\s]+:8888[^\s]*"` — требует, чтобы в токене URL
///   присутствовал именно порт FastPanel `:8888`; произвольный http(s)-URL
///   без этого порта не считается панелью.
/// - User: `r"(?:Username|Login|User)\s*[:=]\s*(\S+)"`, `re.I`.
/// - Password: `r"Password\s*[:=]\s*(\S+)"`, `re.I`.
///
/// Оба keyword-регекса требуют явный разделитель `:` или `=` сразу после
/// ключевого слова (с опциональными пробелами вокруг) — совпадение без
/// разделителя не в счёт.
pub fn parse_fastpanel_credentials(output: &str) -> FpCredentials {
    let mut creds = FpCredentials::default();
    for line in output.lines() {
        let l = line.trim();

        if creds.url.is_none() {
            if let Some(idx) = l.find("http") {
                let tail = &l[idx..];
                if let Some(tok) = tail.split_whitespace().next() {
                    if tok.contains("://") && tok.contains(":8888") {
                        creds.url = Some(tok.trim_end_matches(['.', ',']).to_string());
                    }
                }
            }
        }
        // Username проверяем раньше User, чтобы "User" не съел подстроку "Username".
        for kw in ["Username", "Login", "User"] {
            if creds.user.is_none() {
                if let Some(v) = value_after_key(l, kw) {
                    creds.user = Some(v);
                }
            }
        }
        if creds.password.is_none() {
            if let Some(v) = value_after_key(l, "Password") {
                creds.password = Some(v);
            }
        }
    }
    creds
}

/// Вернуть первый токен после `key:` или `key=` (с опциональными пробелами
/// вокруг разделителя) в строке, регистронезависимо. Без явного разделителя
/// сразу после ключа — `None` (порт `\s*[:=]\s*` из легаси-регекса).
fn value_after_key(line: &str, key: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let key_lower = key.to_ascii_lowercase();
    let pos = lower.find(&key_lower)?;
    let rest = &line[pos + key.len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('='))?;
    let val = rest.split_whitespace().next()?;
    Some(val.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_command_debian_default() {
        assert!(update_command("Ubuntu 22.04").contains("apt-get"));
        assert!(update_command("debian").contains("apt-get"));
        assert!(update_command("").contains("apt-get"));
    }

    #[test]
    fn update_command_rhel_family() {
        assert_eq!(update_command("CentOS 7"), "yum -y update");
        assert_eq!(update_command("AlmaLinux 9"), "yum -y update");
        assert_eq!(update_command("Rocky Linux"), "yum -y update");
    }

    // Legacy `_update_cmd` matches on the bare substring "cent" (regex
    // `cent|rhel|rocky|alma|fedora`), not "centos". A distro string like
    // "Cent OS 7" (space between Cent and OS) still contains "cent" but does
    // NOT contain "centos" as one word — this would break the plan's naive
    // `.contains("centos")` port. Legacy behavior wins.
    #[test]
    fn update_command_matches_bare_cent_substring_like_legacy_regex() {
        assert_eq!(update_command("Cent OS 7"), "yum -y update");
    }

    #[test]
    fn parse_credentials_extracts_url_user_password() {
        let out = "Installation complete\n\
                   Panel URL: https://1.2.3.4:8888\n\
                   Username: fastuser\n\
                   Password: s3cr3t!\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://1.2.3.4:8888"));
        assert_eq!(c.user.as_deref(), Some("fastuser"));
        assert_eq!(c.password.as_deref(), Some("s3cr3t!"));
    }

    #[test]
    fn parse_credentials_handles_login_and_equals() {
        let out = "Login: root\nPassword=abc123\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.user.as_deref(), Some("root"));
        assert_eq!(c.password.as_deref(), Some("abc123"));
    }

    #[test]
    fn parse_credentials_missing_returns_none() {
        let c = parse_fastpanel_credentials("nothing useful here");
        assert!(c.url.is_none() && c.user.is_none() && c.password.is_none());
    }

    // Legacy `_parse_credentials` matches the URL with
    // `r"https?://[^\s]+:8888[^\s]*"` — it specifically requires the
    // FastPanel port ":8888" to appear in the URL token. An http(s) URL
    // without that port must NOT be picked up (the plan's naive
    // "find http, take token" port would wrongly accept it).
    #[test]
    fn parse_credentials_url_without_port_8888_is_ignored() {
        let out = "Visit http://example.com/dashboard for panel access\n";
        let c = parse_fastpanel_credentials(out);
        assert!(c.url.is_none());
    }

    #[test]
    fn parse_credentials_strips_trailing_punctuation_from_url() {
        let out = "Panel: https://5.6.7.8:8888.\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://5.6.7.8:8888"));
    }

    // The plan's own comment claims checking "Username" before "User" avoids
    // "User" swallowing the "Username" substring. With a naive
    // `value_after_key` that doesn't require an explicit separator right
    // after the key, checking "User" first against "Username: alice" would
    // match on the "User" prefix and slice into "name: alice", producing a
    // bogus value instead of None/alice. This test pins the correct result.
    #[test]
    fn parse_credentials_username_line_not_clobbered_by_user_prefix_match() {
        let out = "Username: alice\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.user.as_deref(), Some("alice"));
    }

    // Legacy regex requires `\s*[:=]\s*` directly after the keyword — i.e. an
    // explicit separator. A line where the keyword appears without a
    // separator must not be parsed as a value.
    #[test]
    fn parse_credentials_keyword_without_separator_is_ignored() {
        let out = "Username field is currently empty\n";
        let c = parse_fastpanel_credentials(out);
        assert!(c.user.is_none());
    }

    // Legacy uses `re.I` for the Username/Login/User/Password regexes, so
    // matching must be case-insensitive.
    #[test]
    fn parse_credentials_keywords_are_case_insensitive() {
        let out = "LOGIN: admin\nPASSWORD=Sup3r!\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.user.as_deref(), Some("admin"));
        assert_eq!(c.password.as_deref(), Some("Sup3r!"));
    }

    #[test]
    fn install_cmd_matches_legacy_installer_url() {
        assert_eq!(
            INSTALL_CMD,
            "wget https://repo.fastpanel.direct/install_fastpanel.sh -O - | bash -"
        );
    }
}
