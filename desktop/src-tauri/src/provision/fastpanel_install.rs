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
///
/// Отличие от легаси одно и намеренное: `url`/`user` проходят санитизацию
/// (`sanitize_panel_url`/`sanitize_panel_user`) — эти два значения уезжают на
/// сервер и в аудит, и парсер здесь единственная точка, где их можно
/// перехватить до всех трёх потребителей (ответ команды, write-back, аудит).
pub fn parse_fastpanel_credentials(output: &str) -> FpCredentials {
    let url = url_regex()
        .find(output)
        .map(|m| m.as_str().trim_end_matches(['.', ',']))
        .and_then(sanitize_panel_url);
    let user = user_regex()
        .captures(output)
        .and_then(|c| c.get(1))
        .and_then(|m| sanitize_panel_user(m.as_str()));
    let password = password_regex()
        .captures(output)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string());
    FpCredentials { url, user, password }
}

/// Срезать userinfo из URL панели и отвергнуть то, что панелью быть не может.
///
/// Зачем вообще: `url_regex` матчит `https://admin:s3cr3t@1.2.3.4:8888/` —
/// пароль панели внутри URL. Такой URL уезжает в `servers.fastpanel_url` и в
/// metadata аудита, а гард редакции (`audit_redact.rs`) смотрит на **имена**
/// полей — имя `url` секретным не выглядит, и обе линии обороны пропускают
/// значение (долг №10).
///
/// Креды именно **срезаются**, а не приводят к отказу: по RFC 3986 authority —
/// это `[userinfo@]host[:port]`, то есть без userinfo остаётся тот же самый
/// адрес панели, по которому пользователь и заходит (FastPanel логинит формой,
/// а не HTTP Basic). Отказ здесь стоил бы дорого: адрес свежеустановленной
/// панели больше нигде не существует.
///
/// Режется всё до **последнего `@` во всём токене**, а не userinfo по букве
/// RFC. Разница не теоретическая: в `https://admin:12/345@1.2.3.4:8888` пароль
/// содержит `/`, поэтому по RFC это НЕ userinfo — authority кончается на
/// первом `/` и равна `admin:12`, идеальному «хост:порт», а логин с паролем
/// уезжают в путь и дальше в колонку и в аудит. Инвариант «секрет не попадает
/// на сервер» тут главнее буквы разбора URL, поэтому правило простое: `@` в
/// значении — признак, что перед ним чужое, и всё перед ним отбрасывается.
///
/// Цена — `@` в ПУТИ панельного URL тоже отбрасывается вместе с началом:
/// `https://1.2.3.4:8888/mail@example` даёт `None` (после `@` остаётся
/// `example` без порта). Панельного адреса с `@` в пути не существует —
/// FastPanel живёт в корне, — так что размен в нашу пользу. По той же причине
/// `https://user@evil.com/path@1.2.3.4:8888` теперь не `None`, а
/// `https://1.2.3.4:8888`: всё до последнего `@` объявлено чужим, а уцелевший
/// хвост проверяется как обычно (см. абзац про «другой, но валидный адрес»).
///
/// Управляющие символы (`\S+` их пропускает) обрезают значение, а не отвергают
/// его. Под цветным выводом инсталлятор печатает `\x1b[32m<URL>\x1b[0m`, и в
/// матч попадает хвост `\x1b[0m` — открывающая escape-последовательность в
/// него не входит, регекс стартует с `https?://`. Отказ терял бы адрес панели
/// на каждой цветной установке молча.
///
/// **Порядок операций тут — часть защиты, а не стиль.** Обрезка идёт ПОСЛЕ
/// среза кредов и применяется к `host_port` и `tail` по отдельности. Обрезка
/// первой (так было в `86477cb`) отдавала пароль наружу: в
/// `https://admin:12345\x1b[0m@1.2.3.4:8888` первый управляющий символ сидит
/// внутри userinfo, префикс до него — `https://admin:12345`, и `@` вместе с
/// настоящим хостом отбрасывается. Проверять после этого нечего: `admin:12345`
/// — идеальный «хост:порт», и пароль уезжает в колонку под видом адреса.
/// Со срезом кредов первым от того же входа остаётся `https://1.2.3.4:8888`.
///
/// Раздельная обрезка склеивает части через выкинутый кусок:
/// `https://1.2.3.4:8888\x1b[0m/login` даёт `https://1.2.3.4:8888/login`.
/// Это осознанно и безвредно: `host_port` к этому моменту уже проверен
/// регексом, а `tail` и так произвольный — склеивать нечего, кроме двух
/// проверенных по своим правилам кусков.
///
/// Недоверенным значение от обрезки быть не перестаёт: управляющий символ
/// ВНУТРИ хоста рубит authority (из `https://1.2.3.4:\x078888` остаётся
/// `https://1.2.3.4:`), и проверка «хост:порт» отвергает такое значение целиком.
///
/// Чего обрезка НЕ гарантирует — что уцелевший префикс это «ровно то, что
/// напечатал инсталлятор»: из `https://evil.com:80\x00.trusted.com:8888`
/// получается валидный, но ДРУГОЙ адрес `https://evil.com:80`. Живём с этим
/// осознанно. Во-первых, кредов в нём нет: всё до последнего `@` отброшено
/// раньше; уцелеть они могли бы, только стоя ПОСЛЕ `@`
/// (`https://1.2.3.4:8888@admin:12345` даёт `https://admin:12345`), а URL с
/// логином и паролем после хоста не существует как конструкция — инсталлятору
/// такое печатать неоткуда.
/// Во-вторых, вывод приходит с того самого сервера, куда мы только что зашли
/// по SSH: он и без всяких escape-последовательностей волен напечатать
/// `Panel URL: https://evil.com:8888`, так что обрезка новой возможности не
/// даёт. Значение используется как ссылка «открыть панель», и доверия ему
/// ровно столько же, сколько выводу инсталлятора.
///
/// Отвергается (`None`) то, что после среза userinfo и обрезки не похоже на
/// `хост:порт`. Это не формальность: в `https://user@evil.com/path@1.2.3.4:8888`
/// authority — `user@evil.com`, и без проверки наружу уехал бы
/// `https://evil.com/...`.
///
/// Парное правило на бэкенде — `is_valid_fastpanel_url` в
/// `backend/app/core/validators.py`; там то же значение не чистится, а
/// отвергается 422-ым. Расходиться правилам нельзя, и опасное направление
/// именно это: если бэкенд станет строже здешней очистки, PUT со свежими
/// метаданными панели отвергнется ЦЕЛИКОМ — `server_write_back_body` шлёт
/// `fastpanel_status`/`fastpanel_url`/`fastpanel_user` одним телом, а
/// `log_write_back_failure` провал write-back'а не бросает, только логирует.
/// Панель останется `not_installed`, и проверка идемпотентности в начале
/// `install_fastpanel` при следующем запуске поставит её поверх работающей.
///
/// Известное ограничение: IPv6-литерал (`https://[::1]:8888`) не проходит
/// проверку хоста. Инсталлятор его не печатает — сервер заводится по IPv4
/// `ip_address`, — а поддержка скобочной формы усложнила бы разбор ради
/// случая, которого нет.
fn sanitize_panel_url(raw: &str) -> Option<String> {
    let (scheme, rest) = ["https://", "http://"]
        .into_iter()
        .find_map(|s| raw.strip_prefix(s).map(|rest| (s, rest)))?;

    // Всё до ПОСЛЕДНЕГО `@` во всём токене — за борт, не разбираясь, userinfo
    // это по RFC или нет. Почему не «внутри authority» — в доккомменте.
    let rest = match rest.rfind('@') {
        Some(i) => {
            tracing::warn!(
                target: "provision",
                "fastpanel installer printed an '@' in the panel URL; everything before it dropped"
            );
            &rest[i + 1..]
        }
        None => rest,
    };
    // Authority кончается на первом `/`, `?` или `#`; всё после — путь/запрос.
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    // И только теперь обрезка — по отдельности, чтобы управляющий символ в
    // одной части не утаскивал за собой другую. Порядок объяснён в доккомменте:
    // обрезка до среза кредов превращает пароль в «порт».
    let host_port = cut_at_control(authority);
    let tail = cut_at_control(tail);
    if !host_port_regex().is_match(host_port) {
        tracing::warn!(
            target: "provision",
            "panel URL from installer has no usable host:port; dropped"
        );
        return None;
    }
    Some(format!("{scheme}{host_port}{tail}"))
}

/// Отрезать всё, начиная с первого управляющего ASCII-символа.
///
/// `split(..).next()` всегда даёт хотя бы один элемент, так что
/// `unwrap_or_default` тут только чтобы не тащить `unwrap` в код.
fn cut_at_control(s: &str) -> &str {
    s.split(|c: char| c.is_ascii_control())
        .next()
        .unwrap_or_default()
}

/// Отвергнуть логин панели с управляющими символами.
///
/// Пробелов в значении уже нет (регекс ловит `(\S+)`), а вот `\x1b`/`\x07`
/// проходят — и уезжают в `servers.fastpanel_user` и в аудит.
///
/// Здесь отказ, а не обрезка по первому управляющему символу, как у URL:
/// у URL регекс стартует с `https?://`, поэтому открывающая
/// escape-последовательность в матч не попадает и обрезать надо только хвост.
/// Тут же захват — `(\S+)` сразу после разделителя, и цветной вывод отдаёт
/// `\x1b[32mfastuser\x1b[0m` целиком: обрезка по первому управляющему символу
/// дала бы пустую строку, то есть тот же потерянный логин, но молча и под
/// видом значения. Парное правило на бэкенде — `is_valid_fastpanel_user`
/// в `backend/app/core/validators.py`.
fn sanitize_panel_user(raw: &str) -> Option<String> {
    if raw.bytes().any(|b| b.is_ascii_control()) {
        tracing::warn!(
            target: "provision",
            "panel user from installer has control characters; dropped"
        );
        return None;
    }
    Some(raw.to_string())
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

/// Authority без userinfo: хост (буквы/цифры/`.`/`-`/`_`) и обязательный порт.
///
/// Подчёркивание в хосте по DNS невалидно, но встречается во внутренних именах,
/// и запрет на него ничего не даёт: userinfo режется отдельно, а этот регекс
/// только подтверждает форму «хост:порт».
fn host_port_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._-]+:[0-9]{1,5}$").unwrap())
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

    // Легаси-регекс `https?://\S+:8888\S*` матчит и `https://admin:s3cr3t@ip:8888/`
    // — пароль панели внутри URL. Этот URL уезжает write-back'ом в
    // `servers.fastpanel_url` и в metadata аудита, а гард редакции смотрит на
    // ИМЕНА полей, и имя `url` секретным не выглядит. Userinfo обязана быть
    // срезана до того, как значение покинет парсер.
    #[test]
    fn parse_credentials_strips_userinfo_from_panel_url() {
        let out = "Panel URL: https://admin:s3cr3t@1.2.3.4:8888/login\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://1.2.3.4:8888/login"));
    }

    // Userinfo без пароля — та же userinfo: `@` в authority срезается целиком,
    // иначе логин панели утекал бы в аудит через поле `url`.
    #[test]
    fn parse_credentials_strips_userinfo_without_password() {
        let out = "Panel: http://admin@5.6.7.8:8888\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("http://5.6.7.8:8888"));
    }

    // Проверка «хост:порт» — не формальность: без неё наружу уезжал бы
    // `https://evil.com/path:8888`, где `:8888` сидит в пути, а хост порта не
    // имеет вовсе.
    #[test]
    fn parse_credentials_rejects_url_whose_authority_has_no_port() {
        let out = "See https://evil.com/path:8888 now\n";
        let c = parse_fastpanel_credentials(out);
        assert!(c.url.is_none(), "url = {:?}", c.url);
    }

    // Пароль с `/` внутри — дыра, прожившая с `8b625e4` до этого теста. По RFC
    // это НЕ userinfo (`/` в userinfo не кодируется), поэтому authority
    // кончается на первом `/` и равна `admin:12` — идеальному «хост:порт», а
    // логин с паролем уезжают хвостом в колонку и в аудит. Отсюда правило
    // «режем всё до последнего `@`», а не «режем userinfo по букве RFC».
    #[test]
    fn parse_credentials_drops_credentials_whose_password_contains_a_slash() {
        let out = "Panel URL: https://admin:12/345@1.2.3.4:8888\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://1.2.3.4:8888"));
        let url = c.url.unwrap_or_default();
        assert!(!url.contains("admin") && !url.contains("345"), "креды уцелели: {url}");
    }

    // Обратная сторона того же правила, характеризующий тест: `@` в пути
    // отбрасывается вместе со всем, что перед ним, и адрес, который по RFC
    // был бы `evil.com`, превращается в уцелевший хвост. Кредов в нём нет, а
    // панельного URL с `@` в пути не существует — размен в нашу пользу и
    // задокументирован в доккомменте.
    #[test]
    fn parse_credentials_keeps_only_what_follows_the_last_at_sign() {
        let out = "See https://user@evil.com/path@1.2.3.4:8888 now\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://1.2.3.4:8888"));
    }

    // Инсталлятор с цветным выводом печатает `\x1b[32m<URL>\x1b[0m`. Регекс
    // стартует с `https?://`, поэтому открывающая escape-последовательность в
    // матч не попадает, а закрывающая — попадает: `\S*` жадный, и `\x1b` для
    // него не пробел. Отказ по управляющему символу терял бы адрес панели на
    // каждой такой установке; хвост обрезается, адрес остаётся.
    #[test]
    fn parse_credentials_keeps_panel_url_from_colored_installer_output() {
        let out = "Panel URL: \u{1b}[32mhttps://1.2.3.4:8888\u{1b}[0m\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://1.2.3.4:8888"));
    }

    // Обрезка хвоста — не индульгенция на управляющие символы: сидящий ВНУТРИ
    // адреса оставляет от authority огрызок без порта, и значение не отдаётся
    // вовсе. Ослабь обрезку до «выкинуть управляющие символы отовсюду» — и
    // наружу уехал бы склеенный `https://1.2.3.4:8888`, которого инсталлятор
    // не печатал.
    #[test]
    fn parse_credentials_rejects_panel_url_with_control_character_inside_authority() {
        let out = "Panel URL: https://1.2.3\u{7}.4:8888/\n";
        let c = parse_fastpanel_credentials(out);
        assert!(c.url.is_none(), "url = {:?}", c.url);
    }

    // Порядок «сначала обрезка, потом срез userinfo» превращает пароль в порт:
    // первый управляющий символ сидит ВНУТРИ userinfo, префикс до него —
    // `https://admin:12345`, `@` с настоящим хостом отброшен, а `admin:12345`
    // безупречно проходит проверку «хост:порт». Ровно этот регресс жил в
    // `86477cb`. Правильный порядок отбрасывает userinfo целиком, вместе с
    // сидящим в ней escape'ом.
    #[test]
    fn parse_credentials_does_not_turn_password_into_a_port_when_userinfo_holds_a_control_char() {
        let out = "Panel URL: https://admin:12345\u{1b}[0m@1.2.3.4:8888\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://1.2.3.4:8888"));
        assert!(
            !c.url.unwrap_or_default().contains("12345"),
            "пароль из userinfo уцелел в URL"
        );
    }

    // Характеризующий тест на признанную границу обрезки, а не на желаемое
    // поведение: уцелевший префикс — валидный, но ДРУГОЙ адрес. Держим его
    // видимым, потому что доккоммент обещает ровно это и не больше; кредов в
    // нём нет (userinfo срезана раньше), а соврать про адрес тот же вывод
    // инсталлятора может и без всяких escape-последовательностей.
    #[test]
    fn parse_credentials_control_char_in_host_may_leave_a_different_but_valid_address() {
        let out = "Panel URL: https://evil.com:80\u{0}.trusted.com:8888\n";
        let c = parse_fastpanel_credentials(out);
        assert_eq!(c.url.as_deref(), Some("https://evil.com:80"));
    }

    // То же для логина: `(\S+)` пропускает `\x1b`/`\x07`, а значение уходит в
    // `servers.fastpanel_user` и в metadata аудита.
    #[test]
    fn parse_credentials_rejects_user_with_control_characters() {
        let out = "Username: fast\u{7}user\n";
        let c = parse_fastpanel_credentials(out);
        assert!(c.user.is_none(), "user = {:?}", c.user);
    }

    #[test]
    fn install_cmd_matches_legacy_installer_url() {
        assert_eq!(
            INSTALL_CMD,
            "wget https://repo.fastpanel.direct/install_fastpanel.sh -O - | bash -"
        );
    }
}


