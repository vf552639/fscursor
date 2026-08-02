//! FastPanel install-over-SSH pipeline (порт легаси `fastpanel_task`).

use std::sync::OnceLock;

use regex::Regex;

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
///
/// `password` несёт секрет в открытом виде, поэтому `Debug` реализован
/// вручную и маскирует значение — см. impl ниже (аудит без секретов, см.
/// `CreateFtpResult`/`CreateDbResult` в `ssh/fastpanel.rs`, у которых по той
/// же причине нет `derive(Debug)`).
pub struct FpCredentials {
    pub url: Option<String>,
    pub user: Option<String>,
    pub password: Option<String>,
}

impl std::fmt::Debug for FpCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FpCredentials")
            .field("url", &self.url)
            .field("user", &self.user)
            .field("password", &self.password.as_ref().map(|_| "***"))
            .finish()
    }
}

/// Достать URL панели / логин / пароль из stdout инсталлятора (порт `_parse_credentials`).
///
/// Легаси гоняет три независимых `re.search` по **всему** выводу инсталлятора
/// (не построчно):
/// - URL: `r"https?://[^\s]+:8888[^\s]*"` — без `re.I`; требует, чтобы в
///   токене URL присутствовал именно порт FastPanel `:8888` — произвольный
///   http(s)-URL без этого порта не считается панелью. Токен с `http`, но без
///   `:8888`, не обрывает поиск: `re.search` просто продолжает пробовать
///   более поздние стартовые позиции, пока не найдёт подходящий `:8888`.
/// - User: `r"(?:Username|Login|User)\s*[:=]\s*(\S+)"`, `re.I`.
/// - Password: `r"Password\s*[:=]\s*(\S+)"`, `re.I`.
///
/// `re.search` возвращает **самое левое** совпадение во всём тексте — при
/// нескольких ключевых словах в строке побеждает то, что стоит раньше по
/// тексту, а не по приоритету имени. `\s*` вокруг разделителя матчит и
/// перевод строки, так что `"Username:\nalice\n"` всё ещё разбирается в
/// `alice`. Порт использует `regex` (уже зависимость проекта) над всем
/// текстом, чтобы воспроизвести эту семантику один в один, а не построчный
/// цикл с приоритетом ключевых слов.
pub fn parse_fastpanel_credentials(output: &str) -> FpCredentials {
    let url = url_regex()
        .find(output)
        .map(|m| m.as_str().trim_end_matches(['.', ',']).to_string());
    let user = user_regex()
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    let password = password_regex()
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    FpCredentials { url, user, password }
}

fn url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"https?://\S+:8888\S*").unwrap())
}

fn user_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:Username|Login|User)\s*[:=]\s*(\S+)").unwrap())
}

fn password_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)Password\s*[:=]\s*(\S+)").unwrap())
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
    // "User" swallowing the "Username" substring. The real regex-based
    // mechanism is different: the alternation `(?:Username|Login|User)` at
    // a given start position tries "Username" first and only falls back to
    // "User" if that fails, so "Username: alice" correctly yields "alice"
    // rather than a bogus value sliced out of "name: alice".
    #[test]
    fn parse_credentials_username_line_not_clobbered_by_user_prefix_match() {
        let out = "Username: alice\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.user.as_deref(), Some("alice"));
    }

    // Legacy `re.search` finds the LEFTMOST match in the whole text, not the
    // "highest-priority" keyword. On a line with both "Login" (earlier) and
    // "Username" (later), the earlier one wins — "Login: bob" is matched and
    // returns "bob", even though "Username" is a higher-priority alternative
    // in the pattern. A priority-ordered per-keyword scan (checking
    // "Username" before "Login"/"User" regardless of position) would wrongly
    // return "alice" here.
    #[test]
    fn parse_credentials_leftmost_keyword_wins_over_priority() {
        let out = "Login: bob Username: alice\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.user.as_deref(), Some("bob"));
    }

    // Legacy regexes run over the whole output, and `\s*` matches newlines
    // too, so a value on the line AFTER the key is still captured. A
    // per-line scan requiring key + separator + value on one line would
    // wrongly return None here.
    #[test]
    fn parse_credentials_separator_spans_newline() {
        let out = "Username:\nalice\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.user.as_deref(), Some("alice"));
    }

    // A non-panel http(s) URL earlier in the text must not stop the search:
    // `re.search` keeps trying later start positions until it finds a token
    // that actually contains ":8888". A "first http wins" port would give up
    // after the first (invalid) URL and miss the real panel URL that follows.
    #[test]
    fn parse_credentials_skips_non_panel_url_and_finds_later_panel_url() {
        let out = "See http://example.com/info then https://9.9.9.9:8888 for panel\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://9.9.9.9:8888"));
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

    // FpCredentials carries a plaintext panel password; Debug must never
    // print it (project convention — no secrets in logs/audit, see
    // CreateFtpResult/CreateDbResult which deliberately skip derive(Debug)).
    // Presence/absence still has to be visible for troubleshooting, so
    // Some(password) renders as a fixed placeholder, not the real value.
    #[test]
    fn debug_output_redacts_password_value() {
        let c = parse_fastpanel_credentials(
            "Panel URL: https://1.2.3.4:8888\nUsername: fastuser\nPassword: s3cr3t!\n",
        );
        let debug_str = format!("{c:?}");
        assert!(!debug_str.contains("s3cr3t"));
        assert!(debug_str.contains("fastuser"));
        assert!(debug_str.contains("https://1.2.3.4:8888"));
    }

    #[test]
    fn install_cmd_matches_legacy_installer_url() {
        assert_eq!(
            INSTALL_CMD,
            "wget https://repo.fastpanel.direct/install_fastpanel.sh -O - | bash -"
        );
    }
}
