//! FastPanel operations over SSH (ported from legacy `fastpanel_client.py`).

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use dryoc::rng::randombytes_buf;
use regex::Regex;
use serde::Serialize;
use shell_escape::escape;
use tokio::time::sleep;

use crate::ssh::client::{SshError, SshSession};

/// «Выполнить команду на сервере» — ровно то, чем пользуются функции создания
/// БД и FTP-аккаунта.
///
/// Существует ради проверяемости, а не ради абстракции: единственный
/// прод-реализатор — `SshSession`. Но решения этих функций («создавать или уже
/// есть») стоят пароля, который существует в одном экземпляре, а поднять живой
/// SSH в тесте нельзя. С трейтом сценарий «на сервере уже есть такой
/// пользователь» разыгрывается фейковым сервером, и тест проверяет ЭФФЕКТ —
/// какие команды ушли на сервер и что вернулось наружу, — а не текст собранной
/// строки.
#[async_trait]
pub trait Exec: Send {
    async fn run(&mut self, cmd: &str, timeout: Duration) -> Result<(i32, String), SshError>;
}

#[async_trait]
impl Exec for SshSession {
    async fn run(&mut self, cmd: &str, timeout: Duration) -> Result<(i32, String), SshError> {
        // `pty: false` — как у всех вызовов этого модуля: вывод машинный, а pty
        // подмешал бы в него управляющие последовательности.
        self.exec(cmd, timeout, false).await
    }
}

pub const FASTPANEL_FALLBACK_PATH: &str = "/usr/local/fastpanel2/fastpanel";

/// Предел на `certificates create-le` — самый долгий exec во всём провижининге.
///
/// Публичный, потому что задаёт нижнюю границу для inactivity-таймаута сессии:
/// если russh закроет канал раньше, чем истечёт этот exec, умрёт вся сессия, а
/// не одна команда. Связь проверяется тестом в `commands::provision`.
pub const SSL_ISSUE_EXEC_TIMEOUT: Duration = Duration::from_secs(300);
/// Пауза после выпуска, пока FastPanel разложит файлы сертификата. Идёт вслед
/// за exec'ом выше, поэтому в бюджет тишины сессии входит вместе с ним.
pub const SSL_ISSUE_SETTLE: Duration = Duration::from_secs(5);

/// Сырой вывод команд сюда НЕ кладётся, и это не забывчивость: у `create`-команд
/// FastPanel в argv стоит сгенерированный пароль, а при ошибке они повторяют
/// argv в тексте. Пока поле существовало, оно было мёртвым (читателей ноль), но
/// структуры `Serialize`, и первый же, кто вернул бы такую структуру из
/// Tauri-команды напрямую, отдал бы пароль во фронт. Нет поля — нет пути.
#[derive(Serialize)]
pub struct CreateSiteResult {
    pub site_user: String,
    pub site_path: String,
}

/// Про отсутствующий `output` — см. `CreateSiteResult`.
#[derive(Serialize)]
pub struct CreateFtpResult {
    pub ftp_user: String,
    pub ftp_password: String,
}

/// Про отсутствующий `output` — см. `CreateSiteResult`.
#[derive(Serialize)]
pub struct CreateDbResult {
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
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
    s: &mut impl Exec,
    site_user: &str,
    domain: &str,
) -> Result<bool, SshError> {
    let path = format!("/var/www/{site_user}/data/www/{domain}");
    let (code, _) = s
        .run(&format!("test -d {}", q(&path)), Duration::from_secs(30))
        .await?;
    Ok(code == 0)
}

pub async fn cert_exists(s: &mut impl Exec, domain: &str) -> Result<bool, SshError> {
    let path = format!("/etc/letsencrypt/live/{domain}/fullchain.pem");
    let (code, _) = s
        .run(&format!("test -f {}", q(&path)), Duration::from_secs(30))
        .await?;
    Ok(code == 0)
}

/// Создать сайт. `impl Exec`, а не `SshSession`, ровно затем же, зачем у
/// `create_ftp_account`: единственная защита от секрета в argv этой команды —
/// тест, который видит УШЕДШУЮ на сервер строку (`create_site_argv_has_no_secret`).
/// Её вывод, в отличие от `database create` и `ftp_account create`, уходит в
/// текст ошибки целиком, и цена промаха здесь выше всего.
pub async fn create_site(
    s: &mut impl Exec,
    fp_path: &str,
    domain: &str,
    php_version: &str,
) -> Result<CreateSiteResult, SshError> {
    let site_user = make_site_user(domain);
    let cmd = build_create_site_cmd(fp_path, domain, &site_user, php_version);
    let (code, output) = s.run(&cmd, Duration::from_secs(120)).await?;
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
    })
}

/// Признаки того, что создание FTP-аккаунта упало именно на дубликате.
///
/// Спрашивается только на FTP-пути: у БД свой маркер (`DB_USER_TAKEN_MARKER`).
/// `error 1396` здесь поэтому и не значится — ER_CANNOT_USER выдают только
/// `CREATE USER`/`DROP USER`, и в этом списке он был бы недостижим, зато
/// расширял бы поверхность ложного «уже есть».
///
/// `does not exist` мимо: подстрока `exist` есть и в нём, поэтому маркеры
/// точные, а не «содержит exist». `duplicate entry`, а не `duplicate`: первое —
/// текст ER_DUP_ENTRY, второе ловило бы любое «could not duplicate …».
/// ER_DUP_ENTRY тут достижим: FastPanel держит FTP-аккаунты в собственной
/// MySQL, и вставка с занятым логином приходит оттуда.
const ALREADY_EXISTS_MARKERS: [&str; 4] = [
    "already exists",
    "already exist",
    "already in use",
    "duplicate entry",
];

/// Признак того, что на занятое имя пожаловался именно `CREATE USER`.
///
/// Отдельный, УЖЕ маркеров выше, и не по вкусу. `build_create_db_sql` шлёт в
/// один `mysql -e` четыре оператора; mysql останавливается на первой ошибке, а
/// вывод мы видим целиком и не знаем, чей он. Общие маркеры принадлежали бы
/// любому из четырёх: `GRANT`, упавший с `ERROR 1062 Duplicate entry`, читался
/// бы как «пользователь уже был» — и функция выбросила бы пароль пользователя,
/// созданного двумя операторами раньше, а модалка сказала бы про него «пароль
/// показан один раз при создании». Человек ушёл бы искать в записях пароль,
/// которого там нет.
///
/// `ER_CANNOT_USER` (1396) выдаёт только `CREATE USER`/`DROP USER` — атрибуция
/// однозначна. Всё остальное на этой ветке уходит громким `opaque_exit`.
const DB_USER_TAKEN_MARKER: &str = "error 1396";

/// Пожаловался ли `CREATE USER` на занятое имя. Про чтение вывода — см. ниже.
fn db_user_already_taken(output: &str) -> bool {
    output.to_lowercase().contains(DB_USER_TAKEN_MARKER)
}

/// Похоже ли, что команда упала на «уже существует».
///
/// **Это эвристика по тексту, а не проверка**, и она — про FTP-аккаунт: вторая
/// линия обороны ровно там, где первой (`ftp_exists`) не было, потому что CLI
/// не знает подкоманды `list`. У БД своя, ещё более узкая
/// (`db_user_already_taken`): там вывод общий на четыре оператора батча. Без неё повтор упирался бы в
/// безликий `opaque_exit` с одним кодом возврата, и пользователь читал бы
/// «ошибка на сервере» там, где на самом деле всё уже сделано.
///
/// Цена, которую она стоит, — ложное срабатывание: непрофильный сбой с такой
/// строкой в тексте будет показан как «аккаунт уже существовал, оставили», и
/// пользователь уйдёт уверенным, что доступ у него есть, тогда как аккаунта
/// нет. Сузить её так же, как у БД, не выходит: у `ftp_account create` в argv
/// и сайт, и логин, и пароль, а жалоба на занятый каталог или квоту относится
/// к аккаунту не меньше, чем жалоба на занятый логин, — своего однозначного
/// кода вроде 1396 у FastPanel нет. Поэтому маркеры узкие, а спрашивают её
/// ТОЛЬКО когда существование не установлено (см. вызовы): ответившей проверке веры больше, чем совпадению
/// подстроки, и её «нет» отправляет сбой в `opaque_exit`, как и раньше.
/// Не превращать в первичную проверку и не расширять маркеры «на всякий
/// случай»: каждый расширенный маркер — это ещё один способ соврать про
/// несуществующий доступ.
///
/// Принимает вывод, но НИКОГДА его не возвращает: у `create`-команд в argv
/// стоит сгенерированный пароль, и утилиты повторяют его в тексте ошибки
/// (см. `opaque_exit`). Наружу отсюда уходит один `bool`.
fn looks_like_already_exists(output: &str) -> bool {
    let lower = output.to_lowercase();
    ALREADY_EXISTS_MARKERS.iter().any(|m| lower.contains(m))
}

/// Отрезать всё до первой `[` или `{`.
///
/// `SshSession::exec` сливает stdout и stderr в один поток, поэтому любой
/// баннер, варнинг или строка от sudo, напечатанные перед JSON, ломают разбор
/// целиком — а «не разобрался» уводит проверку в текстовый фолбэк, то есть в
/// самое слабое её место. Дешевле срезать шапку, чем потом гадать по таблице.
fn json_slice(raw: &str) -> &str {
    match raw.find(['[', '{']) {
        Some(i) => &raw[i..],
        None => raw,
    }
}

/// Логины FTP-аккаунтов из JSON-вывода `ftp_account list --json`.
///
/// `None` — «разобрать не удалось», и это НЕ то же самое, что «аккаунтов нет».
/// Список, из которого достались НЕ ВСЕ логины, — тоже `None`: формат вывода
/// FastPanel не документирован, и запись с ключом вне нашей четвёрки означает,
/// что мы читаем его неправильно. Молча решить «аккаунта нет» по такому чтению
/// значило бы пойти создавать поверх существующего — а это ровно тот дефект,
/// ради которого функция и написана. Пропущенных записей нам не видно, поэтому
/// сравниваем длины: их равенство — единственное доказательство, что понят весь
/// список, а не его часть.
fn ftp_logins_from_json(raw: &str) -> Option<Vec<String>> {
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
    let mut logins = Vec::new();
    for item in arr {
        let login = first_non_empty(&[
            item.get("login").and_then(|x| x.as_str()),
            item.get("username").and_then(|x| x.as_str()),
            item.get("user").and_then(|x| x.as_str()),
            item.get("name").and_then(|x| x.as_str()),
        ]);
        if let Some(l) = login {
            logins.push(l.trim().to_string());
        }
    }
    if logins.len() != arr.len() {
        return None;
    }
    Some(logins)
}

/// Разделитель колонок: два и более пробела, табы, вертикальная черта.
///
/// Тот же, что у `parse_sites_from_text_table`, и по той же причине, что важна
/// здесь вдвойне: ОДИНОЧНЫЙ пробел разделителем не считается. Иначе таблицей
/// выглядит любая фраза из двух слов — например `Unknown command 'ftp_account'.
/// See --help`, которую печатает сборка без этой подкоманды, — и проверка
/// уверенно отвечает «аккаунта нет» по выводу, которого не поняла.
fn table_cell_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s{2,}|\t+|\|").unwrap())
}

fn cells(line: &str) -> impl Iterator<Item = &str> {
    table_cell_re()
        .split(line.trim())
        .map(str::trim)
        .filter(|c| !c.is_empty())
}

/// Похож ли вывод на таблицу: есть ли хоть одна строка, которую РАЗДЕЛИТЕЛЬ
/// колонок (не пробел, см. `table_cell_re`) режет минимум на две ячейки.
///
/// Без этой проверки отрицательный ответ текстового фолбэка ничего не стоит.
/// Наличия подкоманды `ftp_account list` в FastPanel CLI никто не гарантировал:
/// сборка без неё печатает `Unknown command 'ftp_account'. See --help` и выходит
/// с кодом 0. Ни одна «ячейка» такой строки логину не равна — и проверка
/// уверенно отвечала «аккаунта нет» по выводу, которого не поняла. Дальше хуже:
/// уверенное «нет» ещё и отключает вторую линию обороны (её спрашивают только
/// при `None`), то есть путь «не понял и признался» был СТРОГО безопаснее, чем
/// «не понял и ответил».
///
/// **Это сужение, а не устранение класса.** Гейт проходит всё, где есть
/// разделитель колонок, — в том числе выровненный help (`  create   Create an
/// FTP account`), `Error:  permission denied` с двойным пробелом и
/// `Try 'fastpanel --help | less'` с вертикальной чертой. Отличить их от
/// таблицы, не видя живого FastPanel, нечем; проверить — на ручной приёмке.
/// Цену остатка снижает то, что положительный ответ берётся и из такого вывода
/// (см. `ftp_exists`): совпадение целой ячейкой гейта не требует.
fn looks_like_a_table(output: &str) -> bool {
    output.lines().any(|line| cells(line).count() >= 2)
}

/// Есть ли в текстовой таблице колонка, равная логину.
///
/// Сравнение по целой колонке, а не `contains`: логин вида `ftp_shop` входит
/// подстрокой и в `ftp_shop_old`, и в путь `/var/www/ftp_shop`, и «нашли»
/// означало бы не создать аккаунт вовсе.
fn text_lists_login(output: &str, login: &str) -> bool {
    output.lines().any(|line| cells(line).any(|cell| cell == login))
}

/// Существует ли FTP-аккаунт с таким логином. `None` — ответить не смогли.
///
/// Парная к `site_exists`/`cert_exists`, но механика другая: у FTP-аккаунта нет
/// ни каталога, ни файла, по которому его видно, — FastPanel держит их в своей
/// базе. Читаем единственным доступным способом, `ftp_account list`, и читать
/// его вывод безопасно: в argv этой команды пароля нет (в отличие от `create`,
/// ради которого и написан `opaque_exit`).
///
/// Три состояния, а не два: «не знаем» — не «нет». Логин детерминирован
/// (`make_ftp_login`), пароль генерируется заново на каждом прогоне, и ошибка в
/// сторону «нет» стоит либо провала на дубликате, либо сменённого пароля у
/// живого аккаунта.
pub async fn ftp_exists(
    s: &mut impl Exec,
    fp_path: &str,
    login: &str,
) -> Result<Option<bool>, SshError> {
    let json_cmd = format!("{} ftp_account list --json", q(fp_path));
    let (code, out) = s.run(&json_cmd, Duration::from_secs(30)).await?;
    if code == 0 {
        if let Some(logins) = ftp_logins_from_json(&out) {
            return Ok(Some(logins.iter().any(|l| l == login)));
        }
    }
    let text_cmd = format!("{} ftp_account list", q(fp_path));
    let (c2, o2) = s.run(&text_cmd, Duration::from_secs(30)).await?;
    if c2 == 0 {
        // Гейт формы — ТОЛЬКО на отрицательный ответ, и это не симметрия ради
        // симметрии. Совпадение целой ячейкой с детерминированным логином —
        // самостоятельное доказательство: чем бы вывод ни был, логин в нём
        // назван. А цены у ошибок разные: ложное «да» стоит несозданного
        // аккаунта, который и так есть, ложное «нет» — создания поверх живого,
        // то есть выдуманного пароля в модалке.
        //
        // Одна колонка (логин на строку) — обычная форма для `list`, и
        // таблицей она не выглядит. Гейт на весь ответ выбрасывал бы вместе с
        // мусором и её.
        if text_lists_login(&o2, login) {
            return Ok(Some(true));
        }
        // «Непустой вывод с кодом 0» — недостаточное основание, чтобы поверить
        // отрицательному ответу: см. `looks_like_a_table`.
        if looks_like_a_table(&o2) {
            return Ok(Some(false));
        }
    }
    Ok(None)
}

/// Исход `create_ftp_account`.
///
/// Enum, а не `CreateFtpResult` с пустым паролем: вызывающий обязан разобрать
/// оба варианта, и «уже было» физически нечем принять за успешное создание — у
/// этого варианта нет поля с паролем.
pub enum FtpCreation {
    Created(CreateFtpResult),
    /// Аккаунт уже есть. Пароля здесь нет и быть не может: его выдал тот
    /// прогон, который аккаунт создал, и больше он не хранится нигде.
    AlreadyExists { ftp_user: String },
}

pub async fn create_ftp_account(
    s: &mut impl Exec,
    fp_path: &str,
    domain: &str,
) -> Result<FtpCreation, SshError> {
    let ftp_user = make_ftp_login(domain);
    // Проверка ДО генерации пароля: сгенерировать его для существующего аккаунта
    // значило бы показать пользователю в модалке пароль, который никуда не
    // подходит (`ftp_account create` пароль существующему логину не меняет).
    let known = ftp_exists(s, fp_path, &ftp_user).await?;
    if known == Some(true) {
        return Ok(FtpCreation::AlreadyExists { ftp_user });
    }
    let password = generate_password(14);
    let cmd = format!(
        "{} ftp_account create --login={} --password={} --site={}",
        q(fp_path),
        q(&ftp_user),
        q(&password),
        q(domain),
    );
    let (code, output) = s.run(&cmd, Duration::from_secs(120)).await?;
    if code != 0 {
        // Вывод читаем, но наружу не отдаём — в нём повторён argv с паролем.
        //
        // `known.is_none()` — то самое сужение эвристики: спрашиваем её только
        // там, где проверки не было вовсе. Сказавшая «нет» проверка авторитетнее
        // совпадения подстроки, и сбой после неё уходит в `opaque_exit` — это
        // громкий и честный отказ вместо обещания несуществующего доступа.
        if known.is_none() && looks_like_already_exists(&output) {
            return Ok(FtpCreation::AlreadyExists { ftp_user });
        }
        return Err(opaque_exit("create_ftp_account", code));
    }
    Ok(FtpCreation::Created(CreateFtpResult {
        ftp_user,
        ftp_password: password,
    }))
}

/// Выпустить сертификат Let's Encrypt.
///
/// `impl Exec` — по той же причине, что и у `create_site`: вывод команды уходит
/// в текст ошибки целиком, и то, что в её argv нет пароля, обязано быть
/// зафиксировано тестом (`issue_ssl_argv_has_no_secret`), а не наблюдением.
pub async fn issue_ssl_certificate(
    s: &mut impl Exec,
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
    let (code, output) = s.run(&cmd, SSL_ISSUE_EXEC_TIMEOUT).await?;
    if code != 0 {
        return Err(SshError::Session(format!("issue_ssl exit {code}: {output}")));
    }
    sleep(SSL_ISSUE_SETTLE).await;
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

/// Что из пары «база + пользователь» уже есть на сервере.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbPresence {
    pub database: bool,
    pub user: bool,
}

/// Команда проверки существования базы и её пользователя.
///
/// Пароля в ней нет ни в argv, ни в самом запросе — поэтому её вывод, в отличие
/// от `database create` и `CREATE USER ... IDENTIFIED BY`, читать безопасно
/// (см. `opaque_exit`).
///
/// Пользователя ищем именно `@'localhost'` — ровно того, кого создаём ниже.
/// Одноимённый `@'%'` нашей команде `CREATE USER 'u'@'localhost'` не мешает: это
/// другая учётка, и пароль у неё свой.
///
/// `-N -B`: без заголовков, колонки табом — чтобы разбирать, а не угадывать.
/// Имена уже прошли `safe_mysql_name` (только `[a-z0-9_]`), так что внутри
/// кавычек им взяться неоткуда.
fn build_db_exists_cmd(database_name: &str, database_user: &str) -> String {
    let sql = format!(
        "SELECT (SELECT COUNT(*) FROM information_schema.SCHEMATA \
         WHERE SCHEMA_NAME='{database_name}'), \
         (SELECT COUNT(*) FROM mysql.user WHERE User='{database_user}' AND Host='localhost')"
    );
    format!("mysql -N -B -e {}", q(&sql))
}

/// Разбор ответа проверки. `None` — строку с двумя числами найти не удалось.
///
/// Ищем первую подходящую строку, а не первую вообще: mysql пишет в тот же
/// поток предупреждения вроде «Using a password on the command line…», и
/// разбирать вслепую первую строку значило бы получить `None` на живом сервере.
fn parse_db_exists_output(output: &str) -> Option<DbPresence> {
    for line in output.lines() {
        let mut cols = line.split_whitespace();
        let (Some(db), Some(user)) = (cols.next(), cols.next()) else {
            continue;
        };
        if let (Ok(db), Ok(user)) = (db.parse::<i64>(), user.parse::<i64>()) {
            return Some(DbPresence {
                database: db > 0,
                user: user > 0,
            });
        }
    }
    None
}

/// Существуют ли база и её пользователь. `None` — проверку выполнить не смогли.
///
/// Парная к `site_exists`/`cert_exists`. Механика — запрос к mysql, потому что
/// файла или каталога, по которому видно базу, не существует; ходим тем же
/// способом, что и fallback создания (`mysql -e` без учётных данных, то есть
/// сокет-авторизацией root'а), — если он не работает, не работает и создание.
///
/// **Про третье состояние, честно.** У `ftp_exists` тройка настоящая: там
/// `None` и `Some(false)` ведут к разным веткам (эвристику по тексту ошибки
/// спрашивают только при `None`). Здесь, в РЕШЕНИИ «создавать ли», третье
/// состояние **вырождено**: `None` и `Some { user: false }` одинаково означают
/// «повода не создавать нет», и подмена одного другим ничего не меняет — это
/// проверено мутацией и осталось зелёным сознательно, а не по недосмотру.
///
/// Так безопасно ровно по одной причине: у `CREATE USER` убран `IF NOT EXISTS`,
/// поэтому занятое имя — не тихий no-op с чужим паролем, а ошибка 1396, которую
/// разбирают ниже. Пропадёт эта причина — «не знаем» снова станет опасным, и
/// тогда третье состояние придётся задействовать по-настоящему.
///
/// В ОТЧЁТЕ пользователю третье состояние не вырождено: `database_exists` у
/// `ExistingDb` равен `None` ровно тогда, когда проверка молчала, и тогда
/// модалка про базу не утверждает ничего.
pub async fn db_exists(
    s: &mut impl Exec,
    database_name: &str,
    database_user: &str,
) -> Result<Option<DbPresence>, SshError> {
    let cmd = build_db_exists_cmd(database_name, database_user);
    let (code, out) = s.run(&cmd, Duration::from_secs(30)).await?;
    if code != 0 {
        return Ok(None);
    }
    Ok(parse_db_exists_output(&out))
}

/// Пользователь БД, который уже был на сервере, и что известно про саму базу.
///
/// Решение «не создавать» принимается по ПОЛЬЗОВАТЕЛЮ: пароль принадлежит ему.
/// Но сказать пользователю «база и пользователь уже существовали» можно только
/// там, где база действительно есть: она могла быть дропнута руками, и тогда
/// текст модалки был бы враньём, а база молча осталась бы несозданной.
/// Поэтому `database_exists` — трёхзначный: `Some(true)` / `Some(false)` там,
/// где проверка ответила, `None` — там, где не ответила и «уже существует»
/// распознано по тексту ошибки.
pub struct ExistingDb {
    pub db_name: String,
    pub db_user: String,
    pub database_exists: Option<bool>,
}

/// Исход `create_database`. Enum по той же причине, что и `FtpCreation`:
/// у варианта «уже было» нет поля с паролем, и принять его за создание нечем.
pub enum DbCreation {
    Created(CreateDbResult),
    AlreadyExists(ExistingDb),
}

/// SQL fallback-создания.
///
/// `CREATE USER` — БЕЗ `IF NOT EXISTS`, и это не мелочь стиля. С ним занятое имя
/// давало команде код 0, а функция возвращала свежесгенерированный пароль,
/// которого у существующего пользователя нет: модалка показывала «скопируйте
/// сейчас, второй раз не покажем» строку, не подходящую ни к чему. Без него тот
/// же случай — громкая ошибка `ER_CANNOT_USER` (1396), которую разбирает
/// `db_user_already_taken`.
///
/// У базы `IF NOT EXISTS` остаётся намеренно: существующая база с отсутствующим
/// пользователем — это недоделанная прошлым прогоном пара, и её надо доделать,
/// а не отбить. Данных существующей базы `CREATE DATABASE IF NOT EXISTS` не
/// трогает.
fn build_create_db_sql(
    database_name: &str,
    database_user: &str,
    database_password: &str,
) -> String {
    format!(
        "CREATE DATABASE IF NOT EXISTS `{database_name}`;\
         CREATE USER '{database_user}'@'localhost' IDENTIFIED BY '{database_password}';\
         GRANT ALL PRIVILEGES ON `{database_name}`.* TO '{database_user}'@'localhost';\
         FLUSH PRIVILEGES;"
    )
}

pub async fn create_database(
    s: &mut impl Exec,
    fp_path: &str,
    domain: &str,
    db_name: Option<&str>,
    db_user: Option<&str>,
) -> Result<DbCreation, SshError> {
    let slug = domain.split_once('.').map(|(a, _)| a).unwrap_or(domain);
    let database_name = safe_mysql_name(
        db_name.unwrap_or(&format!("{slug}_db")),
        "site_db",
    );
    let database_user = safe_mysql_name(db_user.unwrap_or(&format!("{slug}_usr")), "site_usr");

    // Смотрит на ПОЛЬЗОВАТЕЛЯ, а не на базу: пароль принадлежит ему. База без
    // пользователя — недоделанная пара, её нижняя ветка доводит до конца и
    // отдаёт настоящий рабочий пароль; пользователь без пароля, который мы могли
    // бы показать, — это ложь, и вот её мы и отсекаем.
    let presence = db_exists(s, &database_name, &database_user).await?;
    if let Some(present) = presence {
        if present.user {
            return Ok(DbCreation::AlreadyExists(ExistingDb {
                db_name: database_name,
                db_user: database_user,
                // Проверка ответила — значит про базу мы знаем точно, и знание
                // это ниже нигде не выбрасывается: «пользователь есть, а базы
                // нет» пользователю надо сказать, а не замолчать.
                database_exists: Some(present.database),
            }));
        }
    }

    // Пароль генерируем только теперь: для существующего пользователя он был бы
    // мусором, который модалка выдала бы за рабочий.
    let database_password = generate_password(18);

    let fp_cmd = format!(
        "{} database create --name={} --user={} --password={}",
        q(fp_path),
        q(&database_name),
        q(&database_user),
        q(&database_password),
    );
    let (code, _) = s.run(&fp_cmd, Duration::from_secs(60)).await?;
    if code == 0 {
        return Ok(DbCreation::Created(CreateDbResult {
            db_name: database_name,
            db_user: database_user,
            db_password: database_password,
        }));
    }

    let sql = build_create_db_sql(&database_name, &database_user, &database_password);
    let fallback_cmd = format!("mysql -e {}", q(&sql));
    let (fb_code, fb_out) = s.run(&fallback_cmd, Duration::from_secs(60)).await?;
    if fb_code != 0 {
        // Ни `out` (вывод fastpanel с `--password=` в argv), ни `fb_out` (mysql
        // повторяет в ошибке весь запрос, включая IDENTIFIED BY) наружу нельзя.
        // Но прочитать `fb_out` мы имеем право: сюда попадает и случай, когда
        // проверка выше не отработала (`None`), а пользователь на самом деле
        // есть, — и тогда это не ошибка, а «уже было».
        //
        // Два сужения сразу. `presence.is_none()` — то же, что у FTP: если
        // проверка ответила «пользователя нет», её слово весомее совпадения
        // подстроки. И маркер здесь свой, `db_user_already_taken`: вывод —
        // общий на четыре оператора батча, и приписывать `CREATE USER` чужую
        // жалобу нельзя (см. `DB_USER_TAKEN_MARKER`).
        if presence.is_none() && db_user_already_taken(&fb_out) {
            return Ok(DbCreation::AlreadyExists(ExistingDb {
                db_name: database_name,
                db_user: database_user,
                // Проверка молчала — про базу мы не знаем ничего, и врать про
                // неё не будем: модалка скажет только про пользователя.
                database_exists: None,
            }));
        }
        return Err(opaque_exit("create_database", fb_code));
    }
    Ok(DbCreation::Created(CreateDbResult {
        db_name: database_name,
        db_user: database_user,
        db_password: database_password,
    }))
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

fn site_table_header_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(domain|site|owner|php)\b").unwrap())
}

fn site_table_sep_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s{2,}|\t+|\|").unwrap())
}

fn site_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^/var/www/([^/]+)/data/www/([^/]+)$").unwrap())
}

fn parse_sites_from_text_table(output: &str) -> Vec<SiteInfo> {
    let header = site_table_header_re();
    let sep = site_table_sep_re();
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
    let re = site_path_re();
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

/// Команда создания сайта. Зовётся из `create_site` — не «для тестов»: копия,
/// которую проверял тест, а исполнял никто, ровно ничего не гарантировала.
fn build_create_site_cmd(fp_path: &str, domain: &str, site_user: &str, php_version: &str) -> String {
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
    fn make_site_user_slug() {
        assert_eq!(make_site_user("foo-bar.example.com"), "foo_bar_usr");
    }

    // Вывод этих команд повторяет argv (а там `--password=`) или сам SQL с
    // IDENTIFIED BY. Наружу должен уходить только код возврата — поэтому текст
    // пинается целиком: дописать к нему `: {output}` без падения теста нельзя.
    #[test]
    fn opaque_exit_message_is_exactly_step_and_code() {
        assert_eq!(
            opaque_exit("create_database", 1).to_string(),
            "session: create_database exit 1 \
             (output withheld: it echoes the generated password)"
        );
    }

    // ---- существование БД и FTP-аккаунта -----------------------------------

    /// Сервер, которому расписано, что отвечать на какую команду.
    ///
    /// Нужен ровно затем, чтобы проверять ЭФФЕКТ: какие команды ушли на сервер
    /// (в частности — ушла ли создающая команда) и что вернулось наружу. По
    /// строке собранной команды этого не видно, а живой SSH в тесте не поднять.
    struct FakeServer {
        /// `(подстрока команды, код, вывод)`; выигрывает первое совпадение.
        replies: Vec<(&'static str, i32, String)>,
        seen: Vec<String>,
    }

    impl FakeServer {
        fn new(replies: &[(&'static str, i32, &str)]) -> Self {
            FakeServer {
                replies: replies
                    .iter()
                    .map(|(p, c, o)| (*p, *c, (*o).to_string()))
                    .collect(),
                seen: Vec::new(),
            }
        }

        fn ran(&self, needle: &str) -> bool {
            self.seen.iter().any(|c| c.contains(needle))
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
            // Нерасписанная команда = сервер её не знает. Именно так выглядит
            // отсутствующая подкоманда CLI, и именно этот случай не должен
            // молча читаться как «объекта нет».
            Ok((127, format!("command not found: {cmd}")))
        }
    }

    const FP: &str = "/usr/local/fastpanel2/fastpanel";

    // ---- argv команд, чей вывод уходит в текст ошибки ----------------------
    //
    // `create_site` и `issue_ssl_certificate` — единственные две команды
    // модуля, которые кладут сырой вывод в сообщение об ошибке (у остальных
    // стоит `opaque_exit`). Читать этот вывод безопасно ровно до тех пор, пока
    // в argv команды нет секрета: FastPanel CLI при ошибке повторяет argv.
    // Поэтому строка пинается ЦЕЛИКОМ и по факту ухода на сервер — дописать к
    // ней `--password=` (или любой другой аргумент) без падения теста нельзя.
    // Раньше на этом месте стоял `contains` по КОПИИ команды, которую никто не
    // исполнял: он был бы зелёным и в мире, где `create_site` шлёт что угодно.

    #[tokio::test]
    async fn create_site_argv_has_no_secret() {
        let mut s = FakeServer::new(&[("sites create", 1, "boom")]);

        // `unwrap_err` тут нечем: у `CreateSiteResult` намеренно нет `Debug`.
        let err = match create_site(&mut s, FP, "example.com", "8.1").await {
            Err(e) => e,
            Ok(_) => panic!("упавшая команда прочиталась как успех"),
        };

        assert_eq!(
            s.seen,
            vec![
                "/usr/local/fastpanel2/fastpanel sites create --server-name=example.com \
                 --owner=example_usr --create-user --php-version=8.1"
            ]
        );
        // И вывод действительно доезжает до текста ошибки — то есть проверка
        // argv выше не декоративная.
        assert!(err.to_string().contains("boom"), "{err}");
    }

    #[tokio::test]
    async fn issue_ssl_argv_has_no_secret() {
        let mut s = FakeServer::new(&[("certificates create-le", 1, "acme said no")]);

        let err = issue_ssl_certificate(&mut s, FP, "example.com", "user@example.com")
            .await
            .unwrap_err();

        assert_eq!(
            s.seen,
            vec![
                "/usr/local/fastpanel2/fastpanel certificates create-le \
                 --server-name=example.com --email='user@example.com'"
            ]
        );
        assert!(err.to_string().contains("acme said no"), "{err}");
    }

    // Тот самый дефект долга №5: имя пользователя детерминированно, `CREATE USER`
    // существующему пароль не меняет, и функция возвращала свежий пароль, который
    // ни к чему не подходит. Теперь до создания дело не доходит вовсе.
    #[tokio::test]
    async fn create_database_never_invents_a_password_for_an_existing_user() {
        let mut s = FakeServer::new(&[("information_schema", 0, "1\t1")]);

        let out = create_database(&mut s, FP, "example.com", None, None)
            .await
            .unwrap();

        match out {
            DbCreation::AlreadyExists(e) => {
                assert_eq!(e.db_name, "example_db");
                assert_eq!(e.db_user, "example_usr");
                // Проверка ответила — про базу известно точно, и это знание
                // доезжает до модалки.
                assert_eq!(e.database_exists, Some(true));
            }
            DbCreation::Created(_) => panic!("выдал пароль существующему пользователю"),
        }
        // Эффект, ради которого всё: ни одной создающей команды на сервере.
        assert!(!s.ran("database create"), "{:?}", s.seen);
        assert!(!s.ran("CREATE USER"), "{:?}", s.seen);
        // И ни одного пароля в argv — даже сгенерированного «на всякий случай».
        assert!(!s.ran("--password="), "{:?}", s.seen);
    }

    #[tokio::test]
    async fn create_database_creates_when_neither_database_nor_user_exists() {
        let mut s = FakeServer::new(&[
            ("information_schema", 0, "0\t0"),
            ("database create", 0, "ok"),
        ]);

        let out = create_database(&mut s, FP, "example.com", None, None)
            .await
            .unwrap();

        match out {
            DbCreation::Created(r) => {
                assert_eq!(r.db_name, "example_db");
                assert_eq!(r.db_user, "example_usr");
                assert_eq!(r.db_password.len(), 18);
            }
            DbCreation::AlreadyExists(_) => panic!("свободное имя объявлено занятым"),
        }
    }

    // База есть, пользователя нет — это недоделанная прошлым прогоном пара, и
    // отбить её значило бы оставить сайт без доступа к своей же базе навсегда.
    // Пароль здесь настоящий: пользователь создаётся именно сейчас.
    #[tokio::test]
    async fn create_database_finishes_a_half_made_pair() {
        let mut s = FakeServer::new(&[
            ("information_schema", 0, "1\t0"),
            ("database create", 1, "database already exists"),
            ("mysql -e", 0, ""),
        ]);

        let out = create_database(&mut s, FP, "example.com", None, None)
            .await
            .unwrap();

        assert!(matches!(out, DbCreation::Created(_)));
        assert!(s.ran("CREATE USER"), "{:?}", s.seen);
    }

    // Проверка могла не отработать (нет доступа к `mysql.user`, другой сервер
    // БД). Тогда единственный сигнал — ошибка самого `CREATE USER`, и она
    // существует только потому, что `IF NOT EXISTS` из него убран.
    #[tokio::test]
    async fn an_unverifiable_check_still_refuses_to_report_a_created_user() {
        let mut s = FakeServer::new(&[
            ("information_schema", 1, "ERROR 1045: Access denied"),
            ("database create", 1, "failed"),
            (
                "mysql -e",
                1,
                "ERROR 1396 (HY000) at line 1: Operation CREATE USER failed for 'example_usr'@'localhost'",
            ),
        ]);

        let out = create_database(&mut s, FP, "example.com", None, None)
            .await
            .unwrap();

        assert!(matches!(out, DbCreation::AlreadyExists(_)));
    }

    // Батч `CREATE DATABASE; CREATE USER; GRANT; FLUSH` уходит одним `mysql -e`,
    // и вывод у него общий. Упавший GRANT — не «пользователь уже был»:
    // пользователь создан двумя операторами раньше, и его СВЕЖИЙ пароль в этот
    // момент живой. Выбросить его и сказать «пароль показан при создании»
    // значит отправить человека искать в записях то, чего там нет.
    #[tokio::test]
    async fn a_failed_grant_is_not_evidence_that_the_user_already_existed() {
        let mut s = FakeServer::new(&[
            ("information_schema", 1, "ERROR 1045: Access denied"),
            ("database create", 1, "failed"),
            (
                "mysql -e",
                1,
                "ERROR 1062 (23000) at line 1: Duplicate entry 'x' for key 'PRIMARY'",
            ),
        ]);

        let msg = match create_database(&mut s, FP, "example.com", None, None).await {
            Err(e) => e.to_string(),
            Ok(_) => panic!("чужая жалоба приписана CREATE USER"),
        };
        assert!(msg.contains("create_database exit 1"), "{msg}");
    }

    // Настоящий провал остаётся провалом, и его вывод по-прежнему не выходит
    // наружу: mysql повторяет в ошибке весь запрос вместе с IDENTIFIED BY.
    #[tokio::test]
    async fn a_genuine_database_failure_still_hides_its_output() {
        let mut s = FakeServer::new(&[
            ("information_schema", 0, "0\t0"),
            ("database create", 1, "failed"),
            (
                "mysql -e",
                1,
                "ERROR 1064: near \"IDENTIFIED BY 'leakedPassword'\"",
            ),
        ]);

        // Не `unwrap_err()`: он требует `Debug` у Ok-варианта, а `DbCreation`
        // несёт пароль и `Debug` не выводит намеренно — иначе случайный `{:?}`
        // унёс бы его в лог.
        let msg = match create_database(&mut s, FP, "example.com", None, None).await {
            Err(e) => e.to_string(),
            Ok(_) => panic!("настоящий провал выдан за результат"),
        };
        assert!(!msg.contains("leakedPassword"), "{msg}");
        assert!(!msg.contains("IDENTIFIED BY"), "{msg}");
    }

    // Пользователя дропнуть забыли, а базу снесли руками. Решение «не создавать»
    // принимается по пользователю, поэтому база так и останется несозданной —
    // и модалка обязана сказать про неё правду, а не «база уже существовала».
    #[tokio::test]
    async fn a_live_user_over_a_dropped_database_is_reported_precisely() {
        let mut s = FakeServer::new(&[("information_schema", 0, "0\t1")]);

        match create_database(&mut s, FP, "example.com", None, None)
            .await
            .unwrap()
        {
            DbCreation::AlreadyExists(e) => assert_eq!(e.database_exists, Some(false)),
            DbCreation::Created(_) => panic!("выдал пароль существующему пользователю"),
        }
    }

    // Проверка молчала, «уже есть» распознано по тексту ошибки — про саму базу
    // не известно ничего, и выдумывать про неё нельзя ни в одну сторону.
    #[tokio::test]
    async fn an_unverified_duplicate_claims_nothing_about_the_database() {
        let mut s = FakeServer::new(&[
            ("information_schema", 1, "ERROR 1045: Access denied"),
            ("database create", 1, "failed"),
            ("mysql -e", 1, "ERROR 1396 (HY000): Operation CREATE USER failed"),
        ]);

        match create_database(&mut s, FP, "example.com", None, None)
            .await
            .unwrap()
        {
            DbCreation::AlreadyExists(e) => assert_eq!(e.database_exists, None),
            DbCreation::Created(_) => panic!("непроверенный дубликат выдан за созданную базу"),
        }
    }

    // Проверка ОТВЕТИЛА «пользователя нет», а создание всё равно упало с текстом
    // про дубликат. Эвристика по подстроке слабее ответившей проверки: это
    // громкий отказ, а не обещание доступа, которого может не быть.
    #[tokio::test]
    async fn a_confident_no_outweighs_a_duplicate_looking_error() {
        let mut s = FakeServer::new(&[
            ("information_schema", 0, "0\t0"),
            ("database create", 1, "failed"),
            ("mysql -e", 1, "ERROR 1050: table 'x' already exists"),
        ]);

        let msg = match create_database(&mut s, FP, "example.com", None, None).await {
            Err(e) => e.to_string(),
            Ok(_) => panic!("совпадение подстроки перебило ответившую проверку"),
        };
        assert!(msg.contains("create_database exit 1"), "{msg}");
    }

    #[tokio::test]
    async fn a_confident_no_outweighs_a_duplicate_looking_ftp_error() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 0, "[]"),
            ("ftp_account create", 1, "quota entry already exists"),
        ]);

        let msg = match create_ftp_account(&mut s, FP, "example.com").await {
            Err(e) => e.to_string(),
            Ok(_) => panic!("совпадение подстроки перебило ответившую проверку"),
        };
        assert!(msg.contains("create_ftp_account exit 1"), "{msg}");
    }

    // Пароль существующему FTP-аккаунту `ftp_account create` не меняет: показать
    // свежесгенерированный значило бы выдать за рабочий тот, что никуда не
    // подходит, — и затереть в голове пользователя настоящий.
    #[tokio::test]
    async fn create_ftp_account_leaves_an_existing_account_alone() {
        let mut s = FakeServer::new(&[(
            "ftp_account list --json",
            0,
            r#"[{"login":"ftp_example","site":"example.com"}]"#,
        )]);

        let out = create_ftp_account(&mut s, FP, "example.com").await.unwrap();

        match out {
            FtpCreation::AlreadyExists { ftp_user } => assert_eq!(ftp_user, "ftp_example"),
            FtpCreation::Created(_) => panic!("создал поверх существующего аккаунта"),
        }
        assert!(!s.ran("ftp_account create"), "{:?}", s.seen);
        assert!(!s.ran("--password="), "{:?}", s.seen);
    }

    #[tokio::test]
    async fn create_ftp_account_creates_when_the_login_is_free() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 0, r#"[{"login":"ftp_other"}]"#),
            ("ftp_account create", 0, "created"),
        ]);

        let out = create_ftp_account(&mut s, FP, "example.com").await.unwrap();

        match out {
            FtpCreation::Created(r) => {
                assert_eq!(r.ftp_user, "ftp_example");
                assert_eq!(r.ftp_password.len(), 14);
            }
            FtpCreation::AlreadyExists { .. } => panic!("свободный логин объявлен занятым"),
        }
    }

    // Ни одна из подкоманд `list` не поддерживается (её наличие в FastPanel CLI
    // ничем не гарантировано). Тогда «уже существует» распознаётся по ошибке
    // самого создания — но именно как «уже есть», а не как безликий exit-код.
    #[tokio::test]
    async fn create_ftp_account_recognizes_a_duplicate_even_without_a_list_command() {
        let mut s = FakeServer::new(&[(
            "ftp_account create",
            1,
            "error: ftp account with this login already exists",
        )]);

        let out = create_ftp_account(&mut s, FP, "example.com").await.unwrap();

        assert!(matches!(out, FtpCreation::AlreadyExists { .. }));
    }

    #[tokio::test]
    async fn a_genuine_ftp_failure_still_hides_its_output() {
        let mut s = FakeServer::new(&[(
            "ftp_account create",
            2,
            "usage: ftp_account create --login=L --password=leakedPassword",
        )]);

        // Про `unwrap_err` — см. соседний тест про БД.
        let msg = match create_ftp_account(&mut s, FP, "example.com").await {
            Err(e) => e.to_string(),
            Ok(_) => panic!("настоящий провал выдан за результат"),
        };
        assert!(!msg.contains("leakedPassword"), "{msg}");
        assert!(msg.contains("create_ftp_account exit 2"), "{msg}");
    }

    // Сборка без подкоманды `ftp_account` печатает «Unknown command …» и выходит
    // с кодом 0. Это не таблица и не ответ «аккаунта нет»: поверить ему значит
    // пойти создавать поверх живого аккаунта — да ещё и с отключённой второй
    // линией обороны, которую спрашивают только при `None`.
    #[tokio::test]
    async fn an_unknown_command_message_is_not_an_answer() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 127, "unknown option --json"),
            (
                "ftp_account list",
                0,
                "Unknown command 'ftp_account'. See --help",
            ),
        ]);
        assert_eq!(ftp_exists(&mut s, FP, "ftp_example").await.unwrap(), None);
    }

    // …и весь путь целиком: непонятый вывод не должен кончаться созданием
    // поверх существующего аккаунта. Здесь `create` жалуется на дубликат —
    // раньше эту жалобу никто не слушал, потому что проверка «ответила».
    #[tokio::test]
    async fn a_misread_list_does_not_disable_the_second_line_of_defence() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 127, "unknown option --json"),
            ("ftp_account list", 0, "Unknown command 'ftp_account'."),
            ("ftp_account create", 1, "login already exists"),
        ]);

        let out = create_ftp_account(&mut s, FP, "example.com").await.unwrap();
        assert!(matches!(out, FtpCreation::AlreadyExists { .. }));
    }

    // Одна колонка, логин на строку — обычная форма вывода `list`, и таблицей
    // она не выглядит. Гейт формы на ВЕСЬ ответ выбрасывал бы вместе с мусором
    // и точное совпадение целой ячейкой — то есть отправлял бы создание на
    // аккаунт, который в списке назван. Положительный ответ гейта не требует.
    #[tokio::test]
    async fn a_single_column_list_still_answers_yes() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 127, "unknown option --json"),
            ("ftp_account list", 0, "ftp_example\nftp_other"),
        ]);

        let out = create_ftp_account(&mut s, FP, "example.com").await.unwrap();

        assert!(matches!(out, FtpCreation::AlreadyExists { .. }));
        assert!(!s.ran("ftp_account create"), "{:?}", s.seen);
        assert!(!s.ran("--password="), "{:?}", s.seen);
    }

    // Но отрицательный ответ из той же одной колонки — по-прежнему «не знаю»:
    // «логина здесь нет» ничего не значит, если мы не уверены, что читаем
    // список аккаунтов, а не текст ошибки.
    #[tokio::test]
    async fn the_same_single_column_does_not_answer_no() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 127, "unknown option --json"),
            ("ftp_account list", 0, "ftp_other\nftp_third"),
        ]);
        assert_eq!(ftp_exists(&mut s, FP, "ftp_example").await.unwrap(), None);
    }

    // Список разобран частично: во второй записи ключ вне нашей четвёрки. Это
    // значит, что формат мы читаем неправильно, — а «логина нет» по неправильно
    // прочитанному списку и есть создание поверх существующего.
    #[test]
    fn a_partially_understood_list_is_not_understood() {
        assert!(
            ftp_logins_from_json(r#"[{"login":"ftp_other"},{"id":7,"account":"ftp_example"}]"#)
                .is_none()
        );
    }

    // `exec` сливает stdout и stderr: баннер перед JSON ломал разбор целиком и
    // уводил проверку в текстовый фолбэк — то есть в самое слабое её место.
    #[test]
    fn a_banner_in_front_of_json_does_not_break_the_parse() {
        assert_eq!(
            ftp_logins_from_json("Warning: locale not set\n[{\"login\":\"ftp_a\"}]"),
            Some(vec!["ftp_a".to_string()])
        );
    }

    // Пустой список — это ответ «аккаунтов нет», а не «не смогли прочитать».
    #[tokio::test]
    async fn an_empty_ftp_list_means_the_login_is_free() {
        let mut s = FakeServer::new(&[("ftp_account list --json", 0, "[]")]);
        assert_eq!(
            ftp_exists(&mut s, FP, "ftp_example").await.unwrap(),
            Some(false)
        );
    }

    // А вот непонятный вывод — «не знаем», и трактовать его как «нет» нельзя.
    #[tokio::test]
    async fn an_unreadable_ftp_list_answers_dont_know() {
        let mut s = FakeServer::new(&[("ftp_account list", 0, "   ")]);
        assert_eq!(ftp_exists(&mut s, FP, "ftp_example").await.unwrap(), None);
    }

    #[tokio::test]
    async fn ftp_exists_falls_back_to_the_text_table() {
        let mut s = FakeServer::new(&[
            ("ftp_account list --json", 127, "unknown option --json"),
            (
                "ftp_account list",
                0,
                "LOGIN       | SITE        | PATH\nftp_example | example.com | /var/www/x",
            ),
        ]);
        assert_eq!(
            ftp_exists(&mut s, FP, "ftp_example").await.unwrap(),
            Some(true)
        );
    }

    // Список непустой, но логинов из него не достаётся — формат вывода не тот,
    // что мы ждём. «Не знаем» вместо «нет»: иначе создадим поверх живого.
    #[test]
    fn a_list_without_recognizable_logins_is_not_an_empty_list() {
        assert!(ftp_logins_from_json(r#"[{"unexpected":"shape"}]"#).is_none());
        assert_eq!(
            ftp_logins_from_json(r#"{"result":[{"username":"ftp_a"}]}"#),
            Some(vec!["ftp_a".to_string()])
        );
    }

    // Логин сравнивается целой колонкой: `ftp_shop` — подстрока и `ftp_shop_old`,
    // и пути, а ложное «нашли» означает не создать аккаунт вовсе.
    #[test]
    fn text_list_matches_a_whole_column_not_a_substring() {
        assert!(!text_lists_login("ftp_shop_old | site.com", "ftp_shop"));
        assert!(!text_lists_login("/var/www/ftp_shop/data", "ftp_shop"));
        assert!(text_lists_login("ftp_shop | site.com", "ftp_shop"));
    }

    // mysql пишет предупреждения в тот же поток; разбор первой строки вслепую
    // давал бы «не знаем» на живом сервере.
    #[test]
    fn db_presence_is_read_past_warning_lines() {
        assert_eq!(
            parse_db_exists_output("mysql: [Warning] Using a password on the CLI\n0\t1\n"),
            Some(DbPresence {
                database: false,
                user: true
            })
        );
        assert_eq!(parse_db_exists_output("ERROR 1045: Access denied"), None);
    }

    // Проверка ходит за пользователем `@'localhost'` — ровно за тем, кого потом
    // создаёт. Одноимённый `@'%'` — другая учётка с другим паролем.
    #[test]
    fn db_exists_check_carries_no_password_and_targets_the_localhost_user() {
        let cmd = build_db_exists_cmd("example_db", "example_usr");
        assert!(cmd.contains("information_schema"), "{cmd}");
        assert!(cmd.contains("Host='\\''localhost'\\''") || cmd.contains("Host='localhost'"), "{cmd}");
        assert!(!cmd.to_lowercase().contains("identified by"), "{cmd}");
        assert!(!cmd.contains("--password"), "{cmd}");
    }

    // Ядро дефекта №5 одной строкой: `CREATE USER IF NOT EXISTS` для занятого
    // имени — no-op с кодом 0, после которого функция отдавала свежий пароль,
    // не подходящий ни к чему. У базы `IF NOT EXISTS` остаётся: недоделанную
    // пару надо доделать, а не отбить.
    #[test]
    fn create_user_sql_must_fail_loudly_on_a_taken_name() {
        let sql = build_create_db_sql("example_db", "example_usr", "pw");
        assert!(
            !sql.contains("CREATE USER IF NOT EXISTS"),
            "IF NOT EXISTS молча оставляет старый пароль: {sql}"
        );
        assert!(sql.contains("CREATE USER 'example_usr'@'localhost'"), "{sql}");
        assert!(sql.contains("CREATE DATABASE IF NOT EXISTS"), "{sql}");
    }

    // `does not exist` содержит подстроку `exist` — маркеры обязаны быть точными,
    // иначе «объекта нет» читалось бы как «объект уже есть».
    #[test]
    fn a_not_found_message_is_not_an_already_exists_message() {
        assert!(!looks_like_already_exists("ERROR: site does not exist"));
        assert!(!looks_like_already_exists("no such ftp account"));
        // `duplicate` в одиночку — слишком широко: так пишут и про совсем
        // другие сбои, а цена ложного срабатывания — обещанный доступ, которого
        // нет. Ловим текст ER_DUP_ENTRY, а не слово.
        assert!(!looks_like_already_exists("could not duplicate config template"));
        // ER_DUP_ENTRY достижим: FastPanel держит FTP-аккаунты в своей MySQL.
        assert!(looks_like_already_exists("ERROR 1062: Duplicate entry 'x' for key"));
        assert!(looks_like_already_exists("Login already exists"));
        // А ER_CANNOT_USER — нет: его выдаёт только CREATE USER/DROP USER, и в
        // FTP-списке он был бы недостижим, зато расширял бы ложные «уже есть».
        assert!(!looks_like_already_exists("ERROR 1396 (HY000) Operation CREATE USER failed"));
    }

    // У БД маркер свой и уже: вывод общий на четыре оператора батча, и жалоба
    // соседа не должна приписываться `CREATE USER`. 1396 — ER_CANNOT_USER,
    // его выдаёт только он.
    #[test]
    fn the_database_marker_belongs_to_create_user_alone() {
        assert!(db_user_already_taken(
            "ERROR 1396 (HY000) at line 1: Operation CREATE USER failed for 'u'@'localhost'"
        ));
        assert!(!db_user_already_taken(
            "ERROR 1062 (23000): Duplicate entry 'x' for key 'PRIMARY'"
        ));
        assert!(!db_user_already_taken("ERROR: database already exists"));
    }

    // Таблица — это строка, которую режет РАЗДЕЛИТЕЛЬ колонок. Фраза из слов
    // через одиночный пробел таблицей не является: именно так выглядит и
    // `Unknown command …`, и любая другая ошибка, а цена ошибки в эту сторону —
    // лишний `None`, в обратную — создание поверх живого аккаунта.
    #[test]
    fn a_sentence_is_not_a_table() {
        assert!(looks_like_a_table("LOGIN | SITE\nftp_a | a.com"));
        assert!(looks_like_a_table("ftp_a\tsite.com"));
        assert!(looks_like_a_table("ftp_a    site.com"));
        assert!(!looks_like_a_table("Unknown command 'ftp_account'. See --help"));
        assert!(!looks_like_a_table("ftp_a\nftp_b"));
        assert!(!looks_like_a_table("   "));
    }
}
