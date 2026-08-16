//! Чтение состояния существующего домена с сервера FastPanel по SSH.
//!
//! Отдельный файл, а не рост `fastpanel.rs`: тот уже про создание, а чтение —
//! самостоятельная ответственность (и своя цена ошибки: перепутать «не знаем» с
//! «нет» тут значит соврать пользователю про состояние инфраструктуры, а не
//! создать дубликат). Команды и форма их вывода сверены вживую на реальном
//! сервере FastPanel 2 (discovery 2026-08-16) — парсеры написаны по нему, не
//! вслепую.
//!
//! **Ни секретов, ни сырого вывода команд** в `DomainFacts` не попадает: та же
//! дисциплина, что у `CreateSiteResult`/`SiteInfo` в `fastpanel.rs`. Наружу
//! (в UI и через write-back в БД) уходят только распарсенные поля. Пароля FTP в
//! выводе CLI нет и быть не может (подтверждено discovery), в argv команд чтения
//! пароль не попадает вовсе — читаем чужую машину, не мутируем.

use std::time::Duration;

use serde::Serialize;

use crate::ssh::client::{SshError, SshSession};
use crate::ssh::fastpanel::{
    cells, first_non_empty, json_slice, looks_like_a_table, normalize_site_row, q, read_ssl_info,
    Exec, SiteInfo, SslInfo,
};

/// Предел на одну команду чтения. В диапазоне 30–60 с из плана: листинги и
/// `stat` — это секунды, но `sites list --json` на сервере с сотней доменов и
/// `openssl` над цепочкой могут задуматься. Публичный, потому что задаёт нижнюю
/// границу для inactivity-таймаута сессии чтения (`FACTS_SESSION_TIMEOUT` в
/// `commands::domain_facts`), — связь закреплена тестом там же.
pub const FACTS_EXEC_TIMEOUT: Duration = Duration::from_secs(45);

/// Сколько команд чтения снимок делает в худшем случае за одну сессию —
/// `sites list` (+текстовый фолбэк), `databases list` (+mysql-фолбэк),
/// `ftp_account list` (+текст +положительный доскан), `cert_exists`, `openssl`,
/// `stat`-логи, `which fastpanel`. С запасом. Нужен, чтобы прижать
/// `FACTS_SESSION_TIMEOUT` к сумме exec-бюджета тестом, как у SSL.
pub const FACTS_READ_COMMANDS: u32 = 12;

/// Один FTP-аккаунт, как он виден с сервера. **Только логин и домашний каталог:**
/// пароля в выводе FastPanel CLI нет и быть не может (сверено), поэтому его тут
/// негде разместить — как у `CreateFtpResult` наоборот, где поле пароля есть, а
/// сырого вывода нет. `home` нужен, чтобы отфильтровать глобальный список по
/// нашему домену.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct FtpAccount {
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
}

/// Файл лога сайта: путь, есть ли он и его размер. `size_bytes` — `None`, если
/// файла нет (тогда и `exists=false`) либо `stat` не отдал число.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct LogFile {
    pub path: String,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
}

/// Снимок состояния домена, снятый одной SSH-сессией. `Serialize` — уходит и в
/// UI, и в БД через write-back, поэтому ни секретов, ни сырого вывода команд.
/// Без `Debug` намеренно: `SiteInfo`/`SslInfo` его не выводят (их форму не
/// трогаем), да и печатать снимок целиком незачем.
#[derive(Serialize)]
pub struct DomainFacts {
    /// Сайт на сервере (путь, владелец, версия PHP) — `None`, если домена на
    /// сервере нет вовсе. Это отдельное состояние, а не ошибка всего снимка.
    pub site: Option<SiteInfo>,
    pub ssl: SslInfo,
    /// FTP-аккаунты домена. Пароля нет и быть не может (см. `FtpAccount`).
    pub ftp_accounts: Vec<FtpAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub php_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub php_handler: Option<String>,
    pub databases: Vec<String>,
    pub logs: Vec<LogFile>,
}

// ---- PHP: версия и обработчик из `sites list --json` -----------------------
//
// В этой сборке FastPanel PHP-факты лежат в `main_backend`, отдельной команды
// `php` нет (сверено: `php --help` → exit 1). Версию чинит `normalize_site_row`
// (фоллбэк на `main_backend.handler_version`), обработчик выводится здесь.

/// `main_backend.handler` → нормализованный обработчик карточки домена.
///
/// `"php_fpm"` → `"php-fpm"`, `"mpm_itk"`/`mod_php`/apache → `"apache"`, иначе
/// `"unknown"`. Конфиг сайта ради обработчика НЕ парсим: у php_fpm-сайтов
/// apache-конфига нет вовсе, а у apache — есть, то есть «по наличию файла»
/// определялось бы наоборот от правды (сверено discovery). `main_backend.handler`
/// — единственный надёжный источник.
pub(crate) fn php_handler_from_backend(handler: Option<&str>) -> Option<String> {
    let h = handler?.trim().to_lowercase();
    if h.is_empty() {
        return None;
    }
    let mapped = if h == "php_fpm" {
        "php-fpm"
    } else if h == "mpm_itk" || h == "mod_php" || h.contains("apache") {
        "apache"
    } else {
        "unknown"
    };
    Some(mapped.to_string())
}

/// Обработчик PHP из строки `sites list --json` (по `main_backend.handler`).
pub(crate) fn read_php_handler(site_row: &serde_json::Value) -> Option<String> {
    php_handler_from_backend(
        site_row
            .get("main_backend")
            .and_then(|b| b.get("handler"))
            .and_then(|v| v.as_str()),
    )
}

/// Разобрать массив `sites list --json` и найти строку нужного домена.
///
/// `sites list --json` отдаёт голый массив (сверено), но у других сборок он
/// бывает завёрнут в `{result: [...]}`/`{sites: [...]}` — снимаем обёртку, как
/// это делает `list_sites`. Сравнение домена — по полю `domain` (или его
/// синонимам) без регистра.
pub(crate) fn find_site_row(raw: &str, domain: &str) -> Option<serde_json::Value> {
    let mut v: serde_json::Value = serde_json::from_str(json_slice(raw)).ok()?;
    if let Some(obj) = v.as_object_mut() {
        for key in ["result", "sites", "data"] {
            if let Some(inner) = obj.get(key).cloned() {
                v = inner;
                break;
            }
        }
    }
    let arr = v.as_array()?;
    let want = domain.trim().to_lowercase();
    for item in arr {
        let name = first_non_empty(&[
            item.get("domain").and_then(|x| x.as_str()),
            item.get("domain_name").and_then(|x| x.as_str()),
            item.get("server_name").and_then(|x| x.as_str()),
            item.get("name").and_then(|x| x.as_str()),
        ]);
        if let Some(n) = name {
            if n.trim().to_lowercase() == want {
                return Some(item.clone());
            }
        }
    }
    None
}

/// SSL из объекта `certificate{}` строки `sites list --json` — фоллбэк, когда
/// LE-файла на диске нет.
///
/// `read_ssl_info` смотрит только `/etc/letsencrypt/live/<domain>/fullchain.pem`,
/// а у доменов с CloudFlare Origin (`certificate.type=="exists"`) LE-файла нет —
/// без этого обогащения живой серт (в discovery `gala-casino-uk.net`,
/// `expired_at` в 2040) выглядел бы как «сертификата нет». `None` — объекта нет
/// либо дату не разобрать; тогда остаётся честное «серта нет» от `read_ssl_info`.
///
/// ⚠️ `certificate.enabled` бывает `false` даже у валидного будущего серта
/// (сверено) — признаком наличия он НЕ служит, доверяем `expired_at`. Издателя
/// точно не знаем (это не openssl над цепочкой), поэтому `issuer: None`;
/// `is_letsencrypt` — по `type`.
pub(crate) fn ssl_from_certificate(cert: &serde_json::Value) -> Option<SslInfo> {
    let raw = cert.get("expired_at").and_then(|v| v.as_str())?.trim();
    let exp = chrono::DateTime::parse_from_rfc3339(raw)
        .ok()?
        .with_timezone(&chrono::Utc);
    let cert_type = cert.get("type").and_then(|v| v.as_str()).unwrap_or("");
    Some(SslInfo {
        has_certificate: true,
        expires_at: Some(exp),
        issuer: None,
        is_letsencrypt: cert_type.eq_ignore_ascii_case("letsencrypt"),
        error: None,
    })
}

/// Обезличенный класс вместо сырого вывода openssl в `SslInfo::error`.
///
/// `read_ssl_info` шарится с провижинингом и при неудаче openssl кладёт в
/// `error` сырой stdout/stderr. Секрета в нём нет (openssl над публичным сертом),
/// но модуль обещает «ни сырого вывода команд», а `SslInfo` уходит write-back'ом
/// в БД. Чиним на ГРАНИЦЕ фактов, не трогая сам `read_ssl_info`: сырьё есть —
/// заменяем классом, `None` (успех) не трогаем. Форму `SslInfo` не меняем.
const SSL_READ_FAILED: &str = "ssl read failed";

/// Заменить сырой `error` обезличенным классом; успешный путь (`None`) не трогаем.
pub(crate) fn redact_ssl_error(mut ssl: SslInfo) -> SslInfo {
    if ssl.error.is_some() {
        ssl.error = Some(SSL_READ_FAILED.to_string());
    }
    ssl
}

/// Домашний каталог владельца сайта из строки JSON (`owner.home_dir`).
/// По нему строится путь к логам. `None` — владелец в JSON не назван.
fn owner_home_from_row(site_row: &serde_json::Value) -> Option<String> {
    let h = site_row
        .get("owner")
        .and_then(|o| o.get("home_dir"))
        .and_then(|v| v.as_str())?
        .trim();
    if h.is_empty() {
        None
    } else {
        Some(h.trim_end_matches('/').to_string())
    }
}

// ---- FTP-аккаунты ----------------------------------------------------------

/// Аккаунты FTP из JSON-вывода `ftp_account list --json`.
///
/// `None` — «разобрать не удалось», и это НЕ «аккаунтов нет». Список, из которого
/// достались НЕ ВСЕ логины, — тоже `None`: формат вывода не документирован, и
/// запись без узнаваемого логина означает, что мы читаем его неправильно;
/// сравнение длин — единственное доказательство, что понят весь список, а не его
/// часть (та же логика, что была у прежней `ftp_logins_from_json`). `home` —
/// best-effort: нет — `None`, аккаунт всё равно виден.
pub(crate) fn ftp_accounts_from_json(raw: &str) -> Option<Vec<FtpAccount>> {
    let mut v: serde_json::Value = serde_json::from_str(json_slice(raw)).ok()?;
    if let Some(obj) = v.as_object_mut() {
        for key in ["result", "ftp_accounts", "accounts", "data"] {
            if let Some(inner) = obj.get(key).cloned() {
                v = inner;
                break;
            }
        }
    }
    let arr = v.as_array()?;
    let mut accounts = Vec::new();
    for item in arr {
        // `name` в этой сборке — это ЛОГИН FTP (сверено), поэтому он в списке
        // кандидатов наравне с login/username/user.
        let login = first_non_empty(&[
            item.get("login").and_then(|x| x.as_str()),
            item.get("username").and_then(|x| x.as_str()),
            item.get("user").and_then(|x| x.as_str()),
            item.get("name").and_then(|x| x.as_str()),
        ]);
        let home = first_non_empty(&[
            item.get("home_dir").and_then(|x| x.as_str()),
            item.get("home").and_then(|x| x.as_str()),
        ])
        .map(|h| h.trim().to_string());
        if let Some(l) = login {
            accounts.push(FtpAccount {
                login: l.trim().to_string(),
                home,
            });
        }
    }
    if accounts.len() != arr.len() {
        return None;
    }
    Some(accounts)
}

/// Аккаунты FTP из ТЕКСТОВОЙ таблицы `ftp_account list`.
///
/// `None` — заголовок с колонкой логина не распознан: без него позиции колонок
/// неизвестны, и «список из нуля аккаунтов» по такому выводу был бы уверенным
/// «нет» там, где мы просто не поняли формат. Реальный заголовок —
/// `ID LOGIN HOME_DIR WEBSITE_ID WEBSITE_NAME OWNER ENABLED CREATE_AT`
/// (сверено); индекс LOGIN и HOME_DIR берём из него, а не из фиксированной
/// позиции.
pub(crate) fn ftp_accounts_from_text(output: &str) -> Option<Vec<FtpAccount>> {
    let mut login_idx: Option<usize> = None;
    let mut home_idx: Option<usize> = None;
    let mut accounts = Vec::new();
    for line in output.lines() {
        let cols: Vec<&str> = cells(line).collect();
        if cols.is_empty() {
            continue;
        }
        // Строка-разделитель `---+---` — не данные.
        if line.trim().chars().all(|c| "-+| ".contains(c)) {
            continue;
        }
        if login_idx.is_none() {
            // Ищем заголовок: колонка LOGIN/USER даёт индекс логина, колонка с
            // HOME/PATH/DIR — индекс каталога.
            let li = cols.iter().position(|c| {
                let l = c.to_lowercase();
                l == "login" || l == "user" || l == "username"
            });
            if let Some(li) = li {
                login_idx = Some(li);
                home_idx = cols.iter().position(|c| {
                    let l = c.to_lowercase();
                    l.contains("home") || l.contains("path") || l.contains("dir")
                });
            }
            continue;
        }
        let li = login_idx.unwrap();
        let Some(login) = cols.get(li) else { continue };
        let login = login.trim();
        if login.is_empty() {
            continue;
        }
        let home = home_idx
            .and_then(|hi| cols.get(hi))
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty());
        accounts.push(FtpAccount {
            login: login.to_string(),
            home,
        });
    }
    // Заголовок не распознан — «не поняли формат», а не «пусто».
    login_idx?;
    Some(accounts)
}

/// Прочитать список ВСЕХ FTP-аккаунтов сервера. `None` — прочитать целиком не
/// удалось (та же тройка состояний, что у `ftp_exists`, которая на этой функции
/// теперь и стоит). Разбор JSON предпочтителен; текстовая таблица — фолбэк.
///
/// Пароля в argv нет: команда — только `<fp> ftp_account list [--json]`.
pub async fn list_ftp_accounts(
    s: &mut impl Exec,
    fp_path: &str,
) -> Result<Option<Vec<FtpAccount>>, SshError> {
    let json_cmd = format!("{} ftp_account list --json", q(fp_path));
    let (code, out) = s.run(&json_cmd, FACTS_EXEC_TIMEOUT).await?;
    if code == 0 {
        if let Some(accounts) = ftp_accounts_from_json(&out) {
            return Ok(Some(accounts));
        }
    }
    let text_cmd = format!("{} ftp_account list", q(fp_path));
    let (c2, o2) = s.run(&text_cmd, FACTS_EXEC_TIMEOUT).await?;
    if c2 == 0 && looks_like_a_table(&o2) {
        if let Some(accounts) = ftp_accounts_from_text(&o2) {
            return Ok(Some(accounts));
        }
    }
    Ok(None)
}

/// Домашний каталог аккаунта указывает на этот домен?
///
/// `home_dir` FTP — это `/var/www/<owner>/data/www/<domain>` (сверено). Матчим
/// `/www/<domain>` как целый сегмент пути: голое `contains` спутало бы
/// `template1.website` с `template1.website2`.
pub(crate) fn home_matches_domain(home: &str, domain: &str) -> bool {
    let needle = format!("/www/{}", domain.trim().to_lowercase());
    let h = home.to_lowercase();
    // Целый сегмент: `/www/<domain>` либо на конце пути, либо со `/` следом.
    h == needle || h.ends_with(&needle) || h.contains(&format!("{needle}/"))
}

/// Оставить только аккаунты нашего домена (по `home_dir`).
pub(crate) fn filter_ftp_by_domain(accounts: Vec<FtpAccount>, domain: &str) -> Vec<FtpAccount> {
    accounts
        .into_iter()
        .filter(|a| a.home.as_deref().is_some_and(|h| home_matches_domain(h, domain)))
        .collect()
}

// ---- Базы данных -----------------------------------------------------------

/// Имена баз домена из `databases list --json`, отфильтрованные по `site.domain`.
///
/// `None` — JSON не разобран. Фильтр именно по `site.domain`, а НЕ по префиксу
/// имени: имена БД усечены/захешированы (`skonloedb`, `glccasonli`) и с доменом
/// не совпадают (сверено). Пустой `Some(vec![])` — «баз у домена нет», это ответ,
/// а не «не смогли».
pub(crate) fn databases_from_json(raw: &str, domain: &str) -> Option<Vec<String>> {
    let mut v: serde_json::Value = serde_json::from_str(json_slice(raw)).ok()?;
    if let Some(obj) = v.as_object_mut() {
        for key in ["result", "databases", "data"] {
            if let Some(inner) = obj.get(key).cloned() {
                v = inner;
                break;
            }
        }
    }
    let arr = v.as_array()?;
    let want = domain.trim().to_lowercase();
    let mut names = Vec::new();
    for item in arr {
        let site_domain = item
            .get("site")
            .and_then(|s| s.get("domain"))
            .and_then(|d| d.as_str())
            .map(|d| d.trim().to_lowercase());
        if site_domain.as_deref() != Some(want.as_str()) {
            continue;
        }
        if let Some(name) = item.get("name").and_then(|n| n.as_str()) {
            let name = name.trim();
            if !name.is_empty() {
                names.push(name.to_string());
            }
        }
    }
    Some(names)
}

/// Слаг домена (первый лейбл, только `[a-z0-9_]`) — для слабого mysql-фолбэка.
fn domain_slug(domain: &str) -> String {
    let head = domain.split_once('.').map(|(a, _)| a).unwrap_or(domain);
    head.chars()
        .filter_map(|c| {
            if c.is_ascii_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c == '-' || c == '_' {
                Some('_')
            } else {
                None
            }
        })
        .collect()
}

/// Имена баз из `mysql -N -B -e "SHOW DATABASES"`, отсеяв системные и оставив
/// похожие на домен по префиксу. Второй эшелон: на этой сборке имена БД с
/// доменом не совпадают, так что префикс, скорее всего, не поймает ничего, —
/// но лучше пусто, чем ложно. Служебные схемы пропускаем всегда.
pub(crate) fn databases_from_mysql(output: &str, domain: &str) -> Vec<String> {
    const SYSTEM: [&str; 4] = [
        "information_schema",
        "performance_schema",
        "mysql",
        "sys",
    ];
    let slug = domain_slug(domain);
    output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        // Строки-предупреждения mysql («[Warning] Using a password…») содержат
        // пробел; имя базы — нет.
        .filter(|l| !l.contains(char::is_whitespace))
        .filter(|l| !SYSTEM.contains(&l.to_lowercase().as_str()))
        .filter(|l| !slug.is_empty() && l.to_lowercase().starts_with(&slug))
        .map(|l| l.to_string())
        .collect()
}

/// Базы данных нужного домена. Сперва `databases list --json` (фильтр по
/// `site.domain`); не вышло — слабый mysql-фолбэк по префиксу.
///
/// Секретов в argv нет: `SHOW DATABASES` пароля не несёт, `databases list` тоже.
pub async fn list_site_databases(
    s: &mut impl Exec,
    fp_path: &str,
    domain: &str,
) -> Result<Vec<String>, SshError> {
    // Мн.ч. `databases` — НЕ `database`: ед.ч. на этой сборке падает
    // (`expected command but got "database"`, сверено).
    let json_cmd = format!("{} databases list --json", q(fp_path));
    let (code, out) = s.run(&json_cmd, FACTS_EXEC_TIMEOUT).await?;
    if code == 0 {
        if let Some(names) = databases_from_json(&out, domain) {
            return Ok(names);
        }
    }
    let (c2, o2) = s
        .run("mysql -N -B -e 'SHOW DATABASES'", FACTS_EXEC_TIMEOUT)
        .await?;
    if c2 == 0 {
        return Ok(databases_from_mysql(&o2, domain));
    }
    Ok(vec![])
}

// ---- Логи ------------------------------------------------------------------

/// Пути к основным логам сайта. Раскладка: `<home>/logs/<domain>-{frontend,
/// backend}.{access,error}.log` (сверено). `home` — `owner.home_dir`
/// (`/var/www/<owner>/data`).
pub(crate) fn log_candidates(owner_home: &str, domain: &str) -> Vec<String> {
    let base = format!("{}/logs", owner_home.trim_end_matches('/'));
    ["frontend.access", "frontend.error", "backend.access", "backend.error"]
        .iter()
        .map(|kind| format!("{base}/{domain}-{kind}.log"))
        .collect()
}

/// Команда «есть ли файл и его размер» на список путей одним заходом.
///
/// `stat -c %s` даёт размер, `test -f` — существование; печатаем `путь\tразмер`
/// либо `путь\tMISSING`, чтобы разобрать на клиенте без гадания. Пароля в argv
/// нет — только пути логов.
pub(crate) fn build_log_stat_cmd(paths: &[String]) -> String {
    let quoted: Vec<String> = paths.iter().map(|p| q(p)).collect();
    format!(
        "for f in {}; do if [ -f \"$f\" ]; then printf '%s\\t%s\\n' \"$f\" \"$(stat -c %s \"$f\")\"; \
         else printf '%s\\tMISSING\\n' \"$f\"; fi; done",
        quoted.join(" ")
    )
}

/// Разбор вывода `build_log_stat_cmd`: строки `путь\tразмер|MISSING`.
pub(crate) fn parse_log_stats(output: &str) -> Vec<LogFile> {
    let mut logs = Vec::new();
    for line in output.lines() {
        let Some((path, size)) = line.split_once('\t') else {
            continue;
        };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let size = size.trim();
        if size == "MISSING" {
            logs.push(LogFile {
                path: path.to_string(),
                exists: false,
                size_bytes: None,
            });
        } else {
            logs.push(LogFile {
                path: path.to_string(),
                exists: true,
                size_bytes: size.parse::<u64>().ok(),
            });
        }
    }
    logs
}

/// Прочитать существование и размер логов сайта. Пустой `owner_home` → пустой
/// список (без него путь к логам не построить).
pub async fn read_log_paths(
    s: &mut impl Exec,
    domain: &str,
    owner_home: &str,
) -> Result<Vec<LogFile>, SshError> {
    if owner_home.trim().is_empty() {
        return Ok(vec![]);
    }
    let paths = log_candidates(owner_home, domain);
    let cmd = build_log_stat_cmd(&paths);
    // Код возврата игнорируем: цикл `for` завершается успешно и на несуществующих
    // файлах — интересен разбор строк, а не exit.
    let (_, out) = s.run(&cmd, FACTS_EXEC_TIMEOUT).await?;
    Ok(parse_log_stats(&out))
}

// ---- Снимок целиком --------------------------------------------------------

/// Снять весь снимок домена одной сессией.
///
/// Порядок: `sites list --json` (сайт, PHP-версия и обработчик, домашний каталог
/// для логов) → SSL через `read_ssl_info` (точный срез/издатель по openssl) →
/// FTP (глобальный список, отфильтрованный по домену) → базы → логи. Каждый факт
/// деградирует по отдельности: домена нет — `site: None`, серта нет —
/// `has_certificate: false`, список FTP не прочитан — пусто. `Err` возвращается
/// только на смерти самой сессии (транспорт/таймаут), и в её тексте нет ни
/// секретов, ни сырого вывода команд.
pub async fn read_domain_facts(
    s: &mut SshSession,
    fp_path: &str,
    domain: &str,
    site_user: Option<&str>,
) -> Result<DomainFacts, SshError> {
    // 1. Сайт + PHP из sites list --json (богатый источник, покрывает почти всё).
    let sites_cmd = format!("{} sites list --json", q(fp_path));
    let (code, out) = s.run(&sites_cmd, FACTS_EXEC_TIMEOUT).await?;
    let site_row = if code == 0 {
        find_site_row(&out, domain)
    } else {
        None
    };
    let site = site_row.as_ref().and_then(normalize_site_row);
    let php_handler = site_row.as_ref().and_then(read_php_handler);
    let php_version = site.as_ref().and_then(|s| s.php_version.clone());

    // Домашний каталог владельца — для путей логов. Из JSON, иначе из известного
    // системного пользователя (`/var/www/<user>/data`).
    let owner_home = site_row
        .as_ref()
        .and_then(owner_home_from_row)
        .or_else(|| {
            site.as_ref()
                .and_then(|s| s.site_user.as_deref())
                .or(site_user)
                .map(|u| format!("/var/www/{u}/data"))
        });

    // 2. SSL — переиспользуем `read_ssl_info` (openssl над файлом серта): точный
    // срез и издатель, как задумано планом. Но он видит только LE-файл на диске;
    // у доменов с CloudFlare Origin (`certificate.type=="exists"`) его нет, а
    // серт установлен и валиден. Когда файла нет, но в строке сайта есть объект
    // `certificate{}` с разбираемой датой — обогащаем из него (приоритет всё
    // равно у openssl: сюда попадаем только при `has_certificate=false`).
    let mut ssl = redact_ssl_error(read_ssl_info(s, domain).await?);
    if !ssl.has_certificate {
        if let Some(enriched) = site_row
            .as_ref()
            .and_then(|r| r.get("certificate"))
            .filter(|c| c.is_object())
            .and_then(ssl_from_certificate)
        {
            ssl = enriched;
        }
    }

    // 3. FTP — глобальный список, отфильтрованный по домену через home_dir.
    let ftp_all = list_ftp_accounts(s, fp_path).await?.unwrap_or_default();
    let ftp_accounts = filter_ftp_by_domain(ftp_all, domain);

    // 4. Базы.
    let databases = list_site_databases(s, fp_path, domain).await?;

    // 5. Логи.
    let logs = match owner_home {
        Some(home) => read_log_paths(s, domain, &home).await?,
        None => vec![],
    };

    Ok(DomainFacts {
        site,
        ssl,
        ftp_accounts,
        php_version,
        php_handler,
        databases,
        logs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    // ---- реальные фрагменты вывода с живого сервера (discovery 2026-08-16) --

    /// Две реальные строки `sites list --json`: mpm_itk/7.4 и php_fpm/8.3.
    const SITES_JSON: &str = r#"[
      {"id":3,"domain":"fortunerabbitdemogratis.com",
       "index_dir":"/var/www/fortunerabbi_usr/data/www/fortunerabbitdemogratis.com",
       "main_backend":{"handler":"mpm_itk","handler_version":"7.4"},
       "owner":{"id":5,"username":"fortunerabbi_usr","home_dir":"/var/www/fortunerabbi_usr/data"}},
      {"id":8,"domain":"template1.website",
       "index_dir":"/var/www/template1_we_usr/data/www/template1.website",
       "main_backend":{"handler":"php_fpm","handler_version":"8.1"},
       "owner":{"id":10,"username":"template1_we_usr","home_dir":"/var/www/template1_we_usr/data"}}
    ]"#;

    /// Реальный `ftp_account list --json` (сокращённый до двух записей).
    const FTP_JSON: &str = r#"[
      {"id":8,"name":"template1_we","virtualhost":8,
       "home_dir":"/var/www/template1_we_usr/data/www/template1.website",
       "owner":{"id":10,"username":"template1_we_usr"}},
      {"id":4,"name":"gala_casino_","virtualhost":4,
       "home_dir":"/var/www/gala_casino__usr/data/www/gala-casino-uk.net",
       "owner":{"id":6,"username":"gala_casino__usr"}}
    ]"#;

    /// Реальная текстовая таблица `ftp_account list` (заголовок + одна строка).
    const FTP_TEXT: &str = "ID\tLOGIN       \tHOME_DIR                                     \tWEBSITE_ID\tWEBSITE_NAME     \tOWNER           \tENABLED\tCREATE_AT\n\
        8 \ttemplate1_we\t/var/www/template1_we_usr/data/www/template1.website\t8         \ttemplate1.website\ttemplate1_we_usr\ttrue   \t2026-04-20";

    /// `databases list --json` по форме findings (имена усечены, фильтр по
    /// `site.domain`).
    const DB_JSON: &str = r#"[
      {"id":1,"name":"skonloedb","site":{"id":8,"domain":"template1.website"},
       "owner":{"username":"template1_we_usr"},"server":{"type":"mysql"},"charset":"utf8mb4"},
      {"id":2,"name":"glccasonli","site":{"id":4,"domain":"gala-casino-uk.net"},
       "owner":{"username":"gala_casino__usr"},"server":{"type":"mysql"},"charset":"utf8mb4"}
    ]"#;

    // ---- PHP handler --------------------------------------------------------

    #[test]
    fn php_handler_maps_backend_values() {
        assert_eq!(php_handler_from_backend(Some("php_fpm")).as_deref(), Some("php-fpm"));
        assert_eq!(php_handler_from_backend(Some("mpm_itk")).as_deref(), Some("apache"));
        assert_eq!(php_handler_from_backend(Some("mod_php")).as_deref(), Some("apache"));
        assert_eq!(php_handler_from_backend(Some("apache2handler")).as_deref(), Some("apache"));
        assert_eq!(php_handler_from_backend(Some("litespeed")).as_deref(), Some("unknown"));
        assert_eq!(php_handler_from_backend(Some("")), None);
        assert_eq!(php_handler_from_backend(None), None);
    }

    #[test]
    fn php_facts_come_from_main_backend() {
        let row = find_site_row(SITES_JSON, "fortunerabbitdemogratis.com").unwrap();
        assert_eq!(read_php_handler(&row).as_deref(), Some("apache"));
        // Версия PHP чинится в `normalize_site_row` фоллбэком на main_backend.
        let site = normalize_site_row(&row).unwrap();
        assert_eq!(site.php_version.as_deref(), Some("7.4"));

        let row2 = find_site_row(SITES_JSON, "template1.website").unwrap();
        assert_eq!(read_php_handler(&row2).as_deref(), Some("php-fpm"));
        assert_eq!(normalize_site_row(&row2).unwrap().php_version.as_deref(), Some("8.1"));
    }

    // ---- SSL из certificate{} (фоллбэк для CloudFlare Origin) --------------

    #[test]
    fn ssl_enriched_from_certificate_object() {
        // Реальный объект gala-casino-uk.net из discovery: type="exists",
        // enabled=false, но серт валиден до 2040. Доверяем дате, не enabled.
        let cert: serde_json::Value = serde_json::from_str(
            r#"{"id":6,"name":"CloudFlare Origin Certificate_2025-12-09-17-46_59",
                "type":"exists","enabled":false,"expires":5474,
                "created_at":"2025-12-09T17:46:59.147254687Z","expired_at":"2040-12-05T17:42:00Z"}"#,
        )
        .unwrap();
        let ssl = ssl_from_certificate(&cert).unwrap();
        assert!(ssl.has_certificate);
        assert!(!ssl.is_letsencrypt);
        assert_eq!(ssl.issuer, None);
        assert_eq!(
            ssl.expires_at.unwrap().to_rfc3339(),
            "2040-12-05T17:42:00+00:00"
        );

        // LE-серт из объекта — is_letsencrypt=true.
        let le: serde_json::Value = serde_json::from_str(
            r#"{"type":"letsencrypt","enabled":false,"expired_at":"2026-10-03T23:47:45Z"}"#,
        )
        .unwrap();
        assert!(ssl_from_certificate(&le).unwrap().is_letsencrypt);

        // Без разбираемой даты — None (остаётся честное «серта нет»).
        assert!(ssl_from_certificate(&serde_json::json!({"type":"exists"})).is_none());
    }

    #[test]
    fn ssl_error_is_redacted_at_the_facts_boundary() {
        // Сырой вывод openssl (несекретный, но именно СЫРОЙ) не должен уезжать в
        // `DomainFacts`/БД — инвариант «нет сырого вывода команд».
        let raw = SslInfo {
            has_certificate: true,
            expires_at: None,
            issuer: None,
            is_letsencrypt: false,
            error: Some(
                "unable to load certificate\n140735:error:0906D06C:PEM routines:\
                 PEM_read_bio:no start line:/BUILD/crypto/pem/pem_lib.c:707"
                    .into(),
            ),
        };
        let out = redact_ssl_error(raw);
        assert_eq!(out.error.as_deref(), Some("ssl read failed"));
        assert!(!out.error.as_deref().unwrap().contains("PEM"));
        // Прочие поля не тронуты.
        assert!(out.has_certificate);

        // Успешный путь (error=None) не задет.
        let ok = SslInfo {
            has_certificate: true,
            expires_at: None,
            issuer: Some("Let's Encrypt".into()),
            is_letsencrypt: true,
            error: None,
        };
        assert_eq!(redact_ssl_error(ok).error, None);
    }

    #[test]
    fn find_site_row_matches_domain_case_insensitively_and_misses_absent() {
        assert!(find_site_row(SITES_JSON, "TEMPLATE1.WEBSITE").is_some());
        assert!(find_site_row(SITES_JSON, "nope.example").is_none());
    }

    // ---- Базы: фильтр по site.domain, а не по префиксу ----------------------

    #[test]
    fn databases_filtered_by_site_domain() {
        assert_eq!(
            databases_from_json(DB_JSON, "template1.website"),
            Some(vec!["skonloedb".to_string()])
        );
        assert_eq!(
            databases_from_json(DB_JSON, "gala-casino-uk.net"),
            Some(vec!["glccasonli".to_string()])
        );
        // Домена нет — пустой ответ, а не None: JSON разобран, просто баз нет.
        assert_eq!(
            databases_from_json(DB_JSON, "template9.website"),
            Some(vec![])
        );
    }

    #[test]
    fn databases_json_failure_is_none_not_empty() {
        assert_eq!(databases_from_json("expected command but got \"database\"", "x"), None);
    }

    #[test]
    fn mysql_fallback_skips_system_schemas_and_warnings() {
        let out = "mysql: [Warning] Using a password on the command line\n\
                   information_schema\nmysql\ntemplate1_db\ntemplate1_wp\nother_db";
        assert_eq!(
            databases_from_mysql(out, "template1.website"),
            vec!["template1_db".to_string(), "template1_wp".to_string()]
        );
    }

    // ---- FTP: разбор JSON и текста, фильтр по домену ------------------------

    #[test]
    fn ftp_accounts_from_json_reads_login_and_home() {
        let accs = ftp_accounts_from_json(FTP_JSON).unwrap();
        assert_eq!(accs.len(), 2);
        assert_eq!(accs[0].login, "template1_we");
        assert_eq!(
            accs[0].home.as_deref(),
            Some("/var/www/template1_we_usr/data/www/template1.website")
        );
    }

    // Частичный разбор = None (запись без узнаваемого логина), срез баннера,
    // обёртка-объект — перенесено из fastpanel.rs вместе с логикой.
    #[test]
    fn ftp_json_partial_or_banner_or_wrapped() {
        assert!(
            ftp_accounts_from_json(r#"[{"login":"ftp_other"},{"id":7,"account":"ftp_example"}]"#)
                .is_none()
        );
        assert_eq!(
            ftp_accounts_from_json("Warning: locale not set\n[{\"login\":\"ftp_a\"}]")
                .unwrap()
                .into_iter()
                .map(|a| a.login)
                .collect::<Vec<_>>(),
            vec!["ftp_a".to_string()]
        );
        assert!(ftp_accounts_from_json(r#"[{"unexpected":"shape"}]"#).is_none());
        assert_eq!(
            ftp_accounts_from_json(r#"{"result":[{"username":"ftp_a"}]}"#)
                .unwrap()
                .into_iter()
                .map(|a| a.login)
                .collect::<Vec<_>>(),
            vec!["ftp_a".to_string()]
        );
    }

    #[test]
    fn ftp_accounts_from_text_uses_the_header_for_columns() {
        let accs = ftp_accounts_from_text(FTP_TEXT).unwrap();
        assert_eq!(accs.len(), 1);
        assert_eq!(accs[0].login, "template1_we");
        assert_eq!(
            accs[0].home.as_deref(),
            Some("/var/www/template1_we_usr/data/www/template1.website")
        );
    }

    #[test]
    fn ftp_text_without_a_header_is_none() {
        // Одна колонка логинов заголовка не несёт — «не поняли», а не «пусто».
        assert!(ftp_accounts_from_text("ftp_a\nftp_b").is_none());
    }

    #[test]
    fn ftp_filter_matches_whole_domain_segment() {
        assert!(home_matches_domain(
            "/var/www/template1_we_usr/data/www/template1.website",
            "template1.website"
        ));
        // Префикс другого домена не должен матчиться.
        assert!(!home_matches_domain(
            "/var/www/x/data/www/template1.website2",
            "template1.website"
        ));
    }

    #[test]
    fn ftp_filter_keeps_only_our_domain() {
        let accs = ftp_accounts_from_json(FTP_JSON).unwrap();
        let ours = filter_ftp_by_domain(accs, "template1.website");
        assert_eq!(ours.len(), 1);
        assert_eq!(ours[0].login, "template1_we");
    }

    // ---- Логи ---------------------------------------------------------------

    #[test]
    fn log_candidates_follow_the_verified_layout() {
        let paths = log_candidates("/var/www/template1_we_usr/data", "template1.website");
        assert_eq!(
            paths[0],
            "/var/www/template1_we_usr/data/logs/template1.website-frontend.access.log"
        );
        assert_eq!(paths.len(), 4);
    }

    #[test]
    fn parse_log_stats_reads_size_and_missing() {
        let out = "/var/www/u/data/logs/d-frontend.access.log\t89695\n\
                   /var/www/u/data/logs/d-backend.error.log\tMISSING";
        let logs = parse_log_stats(out);
        assert_eq!(logs.len(), 2);
        assert!(logs[0].exists);
        assert_eq!(logs[0].size_bytes, Some(89695));
        assert!(!logs[1].exists);
        assert_eq!(logs[1].size_bytes, None);
    }

    // ---- сервер под расписанные ответы (эффект, а не текст команды) ---------

    struct FakeServer {
        replies: Vec<(&'static str, i32, String)>,
        seen: Vec<String>,
    }

    impl FakeServer {
        fn new(replies: &[(&'static str, i32, &str)]) -> Self {
            FakeServer {
                replies: replies.iter().map(|(p, c, o)| (*p, *c, (*o).to_string())).collect(),
                seen: Vec::new(),
            }
        }
    }

    #[async_trait]
    impl Exec for FakeServer {
        async fn run(&mut self, cmd: &str, _t: Duration) -> Result<(i32, String), SshError> {
            self.seen.push(cmd.to_string());
            for (pat, code, out) in &self.replies {
                if cmd.contains(pat) {
                    return Ok((*code, out.clone()));
                }
            }
            Ok((127, format!("command not found: {cmd}")))
        }
    }

    const FP: &str = "/usr/local/fastpanel2/fastpanel";

    // Ни одна команда чтения не несёт пароля в argv (образец
    // `issue_ssl_argv_has_no_secret`). Прогоняем все три читающие функции и
    // смотрим на РЕАЛЬНО ушедшие на сервер строки.
    #[tokio::test]
    async fn read_commands_argv_has_no_secret() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 0, FTP_JSON),
            ("databases list --json", 0, DB_JSON),
        ]);
        let _ = list_ftp_accounts(&mut s, FP).await.unwrap();
        let _ = list_site_databases(&mut s, FP, "template1.website").await.unwrap();
        let _ = read_log_paths(&mut s, "template1.website", "/var/www/template1_we_usr/data")
            .await
            .unwrap();

        for cmd in &s.seen {
            assert!(!cmd.contains("password"), "секрет в argv чтения: {cmd}");
            assert!(!cmd.contains("--password"), "секрет в argv чтения: {cmd}");
            assert!(!cmd.to_lowercase().contains("identified by"), "секрет в argv: {cmd}");
        }
        // И заодно: команда баз — множественного числа.
        assert!(s.seen.iter().any(|c| c.contains("databases list --json")));
        assert!(!s.seen.iter().any(|c| c.contains(" database list")));
    }

    #[tokio::test]
    async fn list_ftp_accounts_prefers_json() {
        let mut s = FakeServer::new(&[("ftp_account list --json", 0, FTP_JSON)]);
        let accs = list_ftp_accounts(&mut s, FP).await.unwrap().unwrap();
        assert_eq!(accs.len(), 2);
        // JSON понят — текстовая команда не нужна.
        assert!(!s.seen.iter().any(|c| c.ends_with("ftp_account list")));
    }

    #[tokio::test]
    async fn list_ftp_accounts_falls_back_to_text() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 127, "unknown option --json"),
            ("ftp_account list", 0, FTP_TEXT),
        ]);
        let accs = list_ftp_accounts(&mut s, FP).await.unwrap().unwrap();
        assert_eq!(accs.len(), 1);
        assert_eq!(accs[0].login, "template1_we");
    }

    #[tokio::test]
    async fn list_site_databases_falls_back_to_mysql() {
        let mut s = FakeServer::new(&[
            ("databases list --json", 1, "expected command but got \"database\""),
            ("SHOW DATABASES", 0, "information_schema\ntemplate1_db\nother"),
        ]);
        let dbs = list_site_databases(&mut s, FP, "template1.website").await.unwrap();
        assert_eq!(dbs, vec!["template1_db".to_string()]);
    }
}
