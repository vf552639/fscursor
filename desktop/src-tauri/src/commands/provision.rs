use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use zeroize::Zeroize;

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
use crate::ssh::fastpanel::{
    self, CreateDbResult, CreateFtpResult, CreateSiteResult, DbCreation, ExistingDb, FtpCreation,
    SslInfo,
};
use crate::sync::cache;
use crate::sync::http::{ApiClient, ApiError, DomainWriteBack, ServerWriteBack};

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
    pub db: Option<DbOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp: Option<FtpOut>,
}

/// Что стало с базой домена. Намеренно без `Debug`: `db_password` существует
/// только здесь, и случайный `{:?}` не должен уносить его в лог.
///
/// Состояний три, и вместе с `Option` они все различимы: `None` — базу не
/// просили (`with_db: false`), `Created` — создали этим прогоном, `Exists` — уже
/// была. Свалить последние два в одно нельзя: у существующей базы пароль выдан
/// прошлым прогоном и больше нигде не хранится, а `CreateDbResult` с
/// придуманным паролем модалка честно показала бы под подписью «скопируйте
/// сейчас» — ровно тот дефект, который здесь и чинится. Отдельный вариант без
/// поля пароля делает такую подмену невозможной по типу — как `ssl_issued`
/// рядом, где «не выпускали» и «не вышло» тоже разведены.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DbOut {
    Created {
        db_name: String,
        db_user: String,
        /// Пароль БД: чувствительно, показывать по образцу RevealSecret.
        db_password: String,
    },
    Exists {
        db_name: String,
        db_user: String,
        /// Есть ли сама база — `None`, если проверить не удалось и «уже
        /// существует» распознано по тексту ошибки создания.
        ///
        /// Решение «не создавать» принимается по пользователю (пароль его), а
        /// база могла быть дропнута руками. Без этого поля модалка утверждала
        /// бы «база и пользователь уже существовали» и там, где базы нет:
        /// пользователь ушёл бы с уверенностью, что она есть, а провижининг её
        /// не досоздал.
        #[serde(skip_serializing_if = "Option::is_none")]
        database_exists: Option<bool>,
    },
}

/// Что стало с FTP-аккаунтом домена. Без `Debug` — по той же причине, что и
/// `DbOut`, и с тем же разделением «создали» / «уже было».
///
/// `output` из `CreateFtpResult` сюда не переносится: это сырой вывод команды,
/// пользы в нём нет, а гарантий, что FastPanel не повторит в нём пароль, — тоже.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FtpOut {
    Created {
        ftp_user: String,
        /// Пароль FTP: генерируется на сервере и больше нигде не хранится —
        /// показывать по образцу RevealSecret, как пароль БД и пароль панели.
        ftp_password: String,
    },
    Exists {
        ftp_user: String,
    },
}

impl DbOut {
    /// Имя пользователя БД — оно правдиво в обоих вариантах: он либо создан
    /// этим прогоном, либо существовал до него. Write-back записывает его и
    /// там, где ничего не создавал: прошлый прогон мог не дописать его на
    /// сервер (write-back best-effort), и повтор обязан эту дыру закрывать.
    fn db_user(&self) -> &str {
        match self {
            DbOut::Created { db_user, .. } | DbOut::Exists { db_user, .. } => db_user,
        }
    }

    /// Имя базы — ТОЛЬКО если база действительно есть.
    ///
    /// В варианте `Exists { database_exists: Some(false) }` её нет: гард стоит
    /// на пользователе, и базу, снесённую руками, провижининг не досоздаёт.
    /// Записать туда имя значило бы показать его в карточке домена рядом с
    /// модалкой, которая на том же экране говорит, что базы нет. `None` здесь
    /// означает «поле не трогаем» (сервер читает `exclude_unset`): стереть
    /// чужое прошлое значение мы тоже не вправе — знания, что это то же имя, у
    /// нас нет.
    fn db_name_if_present(&self) -> Option<&str> {
        match self {
            DbOut::Created { db_name, .. } => Some(db_name),
            DbOut::Exists {
                db_name,
                database_exists,
                ..
            } => (*database_exists != Some(false)).then_some(db_name.as_str()),
        }
    }
}

/// Что стало с одним доменом массового прогона.
///
/// Три состояния, а не два: «не запускался» — это не «упал». Прогон, оборванный
/// на середине, обязан сказать, какие домены уже сделаны (повторять их незачем),
/// какой домен свалил прогон и до каких дело вообще не дошло — иначе повтор
/// приходится запускать вслепую по всему набору.
#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum BulkItemOutcome {
    /// Домен отработал. `result` несёт пароли FTP (и БД, если бы она была) —
    /// они существуют ТОЛЬКО здесь, поэтому отбрасывать их нельзя.
    Done { result: ProvisionResultOut },
    /// Домен упал. Текст ошибки — тот же, что вернул бы одиночный provision.
    Failed { error: String },
    /// До домена прогон не дошёл: оборвался раньше либо не стартовал вовсе.
    Skipped,
}

/// Строка отчёта массового прогона. `domain_id` дублирует `result.domain_id`
/// намеренно: у `Failed`/`Skipped` результата нет, а назвать домен надо всё
/// равно — иначе отчёт не сопоставить со списком, который просили провижинить.
#[derive(Serialize)]
pub struct BulkProvisionItem {
    pub domain_id: String,
    #[serde(flatten)]
    pub outcome: BulkItemOutcome,
}

/// Исход массового прогона целиком.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum BulkRunStatus {
    /// Все домены отработали.
    Ok,
    /// Прогон оборвался (или не смог записать финальный статус). Часть доменов
    /// при этом могла отработать — их результаты лежат в `items`.
    Failed,
    /// Прогон с этим ключом идёт или уже прошёл. Результатов у нас нет и быть
    /// не может: пароли показываются один раз и нигде не сохраняются.
    AlreadyRan,
}

/// Отчёт `provision_bulk`.
///
/// Раньше команда отдавала один `String` — ключ идемпотентности, — а `Ok`
/// каждого домена отбрасывала. На каждом не-`site_only` прогоне создаётся
/// FTP-аккаунт, пароль которого возвращается только в этом ответе, так что
/// массовый прогон оставлял пользователя с N аккаунтами, войти в которые он не
/// сможет никогда. Поэтому наружу уходит отчёт по каждому домену.
#[derive(Serialize)]
pub struct BulkProvisionOut {
    pub idempotency_key: String,
    pub status: BulkRunStatus,
    /// Причина обрыва — только при `status: failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Статус ПРЕДЫДУЩЕГО прогона с этим ключом — только при `already_ran`.
    ///
    /// `running` и `done` — совершенно разные новости, и слепив их в одно
    /// «прогон уже был», мы врём в половине случаев: `running` означает, что
    /// прогон могли и оборвать на середине (краш, `Cmd+Q`, ребут), и тогда
    /// «пароли уже показаны» — неправда, их никто не видел.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_status: Option<String>,
    /// По строке на каждый домен из запроса, в том же порядке.
    pub items: Vec<BulkProvisionItem>,
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
/// ACME-валидацию и молчит минутами. Но и ровно 300s брать нельзя — это в
/// точности exec-таймаут самой команды, и кто сработает первым, было бы гонкой.
/// Разница принципиальная: exec-таймаут убивает команду, и её ошибку ловит
/// non-fatal ветка SSL, а inactivity убивает СЕССИЮ — тогда следующий шаг
/// (`create_database`) падает уже намертво, и пользователь теряет отчёт об
/// удавшихся site и FTP. Берём 420s: 120s запаса, чтобы exec провёл границу
/// заведомо раньше.
const PROVISION_SESSION_TIMEOUT: Duration = Duration::from_secs(420);
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
/// Вторая линия обороны: `create_database` уже отдаёт обезличенный
/// `opaque_exit`, но её `?` пропускает и любой другой `SshError::Session`,
/// который может нести вывод команды. Схлопываем весь вариант; остальные
/// (`auth failed`, `io: ...`) вывода не содержат и идут как есть.
fn db_error(e: SshError) -> CommandError {
    match e {
        SshError::Session(m) if m == "exec timeout" => CommandError::Api(
            "database creation timed out — check the MySQL/MariaDB service on the server".into(),
        ),
        SshError::Session(_) => CommandError::Api(
            "database creation failed on the server (output withheld: it echoes the generated \
             db password) — run `fastpanel database create` manually or check the MySQL log"
                .into(),
        ),
        other => CommandError::from(other),
    }
}

/// Шаги провижининга — те же строки, что уходят в `provision:progress` (их
/// читает `PROVISION_STEP_LABEL` фронта) и в `steps` аудита. Одно значение на
/// три места: разъехавшись, они назвали бы пользователю не тот шаг.
///
/// `prepare` — всё, что до первой команды на сервере: keychain, локальный кэш,
/// расшифровка блоба с SSH-паролем.
const STEP_PREPARE: &str = "prepare";
const STEP_SSH_CONNECT: &str = "ssh_connect";
const STEP_FASTPANEL_PATH: &str = "fastpanel_path";
const STEP_FIREWALL: &str = "firewall_preflight";
const STEP_CREATE_SITE: &str = "create_site";
const STEP_FTP: &str = "ftp";
const STEP_DB: &str = "db";

/// Классы причин провала — ровно то, что разрешено назвать СЕРВЕРУ.
///
/// Это и есть инвариант ZK для `domains.last_provision_error`: колонка уезжает
/// на сервер, оттуда в веб-панель и в CSV-экспорт, а сервер плейнтекст-секретов
/// видеть не должен никогда. Тексты — константы, а не куски `e.to_string()`:
/// сырой вывод команды (в котором FastPanel повторяет argv, а mysql — `CREATE
/// USER ... IDENTIFIED BY`) на сервер не уходит ни при каком стечении.
const CAUSE_SSH_AUTH: &str = "ssh authentication failed";
const CAUSE_SSH_CONNECT: &str = "could not open an ssh connection";
const CAUSE_SSH_HOST_KEY: &str = "the ssh host key was not accepted";
const CAUSE_SSH_BROKEN: &str = "the ssh connection broke";
const CAUSE_TIMEOUT: &str = "the command timed out on the server";
const CAUSE_COMMAND_FAILED: &str = "the command failed on the server";
const CAUSE_NO_FASTPANEL: &str = "fastpanel is not installed on the server";
const CAUSE_VAULT: &str = "the vault is locked or unavailable on the desktop";
const CAUSE_DECRYPT: &str = "the stored ssh password could not be decrypted";

/// Провал провижининга: шаг, класс причины и сама ошибка.
///
/// Два разных читателя, и они получают разное. Десктоп (`error`) — полный текст,
/// включая вывод упавшей команды: он никуда с машины не уходит и нужен, чтобы
/// чинить. Сервер (`step` + `cause`) — только эти два `&'static str`.
///
/// `&'static str` здесь не стиль, а сама гарантия: из значения ошибки в текст,
/// уезжающий на сервер, не может утечь ни байта — такой тип неоткуда взять,
/// кроме как из константы. Проверка сдвинута с ревью на компилятор.
struct ProvisionFailure {
    step: &'static str,
    /// `None` — класс неизвестен; тогда пользователю достаётся один шаг. Врать
    /// про причину хуже, чем промолчать о ней.
    cause: Option<&'static str>,
    error: CommandError,
}

/// Класс ошибки SSH по её тексту. Возвращает КОНСТАНТУ — см. `ProvisionFailure`.
///
/// Разбор по строке, а не по варианту `SshError`: до этого места ошибка уже
/// схлопнута в `CommandError::Ssh(String)` (`ssh_connect_session_with_timeout`
/// отдаёт именно его), и восстанавливать вариант ради матчинга значило бы
/// держать две дороги к одному ответу. Формат строк задан `Display` у
/// `SshError` в этом же крейте.
fn ssh_cause(msg: &str) -> &'static str {
    let m = msg.trim_start_matches("ssh: ");
    // `starts_with`, а не равенство: у `SshError::Auth` за словами «auth failed»
    // идёт хвост с `user@host:port` и подсказкой, что чинить. С точным
    // сравнением добавление этого хвоста уронило бы класс в
    // `CAUSE_COMMAND_FAILED` — то есть провалившийся по паролю провижининг
    // рассказывал бы пользователю «команда не отработала на сервере», и никакой
    // компилятор про это не сказал бы.
    if m.starts_with("auth failed") {
        CAUSE_SSH_AUTH
    } else if m.starts_with("connect:") {
        CAUSE_SSH_CONNECT
    } else if m.starts_with("host key") {
        CAUSE_SSH_HOST_KEY
    } else if m.starts_with("io:") {
        CAUSE_SSH_BROKEN
    } else if m.contains("exec timeout") {
        CAUSE_TIMEOUT
    } else {
        CAUSE_COMMAND_FAILED
    }
}

/// Класс ошибки шага по её `CommandError`.
fn failure_cause(e: &CommandError) -> Option<&'static str> {
    match e {
        CommandError::Keychain(_) => Some(CAUSE_VAULT),
        CommandError::Kdf(_) | CommandError::Aead(_) | CommandError::Recovery(_) => {
            Some(CAUSE_DECRYPT)
        }
        CommandError::Ssh(m) => Some(ssh_cause(m)),
        // `Api` несёт слишком разное — от «домена нет в локальном кэше» до
        // ответа сервера, — и одного честного класса на всё это нет.
        CommandError::Api(_) => None,
    }
}

impl ProvisionFailure {
    /// Провал названного шага. `impl Into<CommandError>` — чтобы одинаково
    /// принимать и `SshError` шагов, и `CommandError` подготовки.
    fn at(step: &'static str, e: impl Into<CommandError>) -> Self {
        let error = e.into();
        Self {
            step,
            cause: failure_cause(&error),
            error,
        }
    }

    /// Провал с заранее известным классом — там, где ошибку конструируем мы
    /// сами и её текст ни о чём серверу не скажет.
    fn known(step: &'static str, cause: &'static str, error: CommandError) -> Self {
        Self {
            step,
            cause: Some(cause),
            error,
        }
    }

    /// Провал создания БД: наружу (и в UI десктопа) уходит обезличенный
    /// `db_error`, а класс берётся из исходной `SshError` — она различает
    /// таймаут и обычный провал, а `db_error` эту разницу уже стёр бы в `Api`.
    fn db(e: SshError) -> Self {
        let cause = ssh_cause(&e.to_string());
        Self {
            step: STEP_DB,
            cause: Some(cause),
            error: db_error(e),
        }
    }

    /// Текст для серверной колонки `last_provision_error`.
    ///
    /// Собирается только из `step` и `cause` — оба `&'static str`.
    fn server_text(&self) -> String {
        match self.cause {
            Some(c) => format!("provision failed at {}: {c}", self.step),
            None => format!("provision failed at {}", self.step),
        }
    }
}

/// Ошибка подготовки (до первой команды на сервере) — чтобы `?` в этой части
/// `provision_domain_inner` работал без обвязки на каждой строке.
impl From<CommandError> for ProvisionFailure {
    fn from(e: CommandError) -> Self {
        Self::at(STEP_PREPARE, e)
    }
}

/// Сколько сертификату должно оставаться до истечения, чтобы считать его
/// пригодным и не выпускать заново.
///
/// certbot продлевает за 30 дней до конца. Если осталось меньше суток, значит
/// продление уже не работает, и пропустить выпуск — значит оставить сайт без
/// SSL. Брать порог в те же 30 дней нельзя: тогда любой повторный provision в
/// последний месяц жизни сертификата жёг бы лимит дубликатов Let's Encrypt.
const SSL_REUSE_MIN_REMAINING_HOURS: i64 = 24;

/// Годится ли найденный сертификат, чтобы пропустить выпуск.
///
/// Само наличие файла ничего не доказывает: `/etc/letsencrypt/live/{domain}`
/// переживает удаление сайта, а срок действия в имени файла не написан.
/// Не смогли разобрать `notAfter` — считаем, что не знаем, и выпускаем: лишний
/// выпуск переживём, а сайт, навсегда оставшийся на голом HTTP, — нет.
fn cert_good_enough(info: &SslInfo, now: chrono::DateTime<chrono::Utc>) -> bool {
    if !info.has_certificate {
        return false;
    }
    match info.expires_at {
        Some(exp) => exp > now + chrono::Duration::hours(SSL_REUSE_MIN_REMAINING_HOURS),
        None => false,
    }
}

/// Почему SSL пропущен из-за DNS — с данными, по которым это можно починить.
///
/// Самый частый реальный случай — не «запись ещё не доехала», а оранжевое
/// облако Cloudflare: домен резолвится прекрасно, только в прокси-IP, и тогда
/// HTTP-01 на этом сервере не пройдёт НИКОГДА. Поэтому имя, ожидаемый IP и
/// число попыток должны быть в тексте, а не подразумеваться.
fn dns_gate_message(domain: &str, expected_ip: &str, attempts: u32) -> String {
    format!(
        "{domain} does not resolve to {expected_ip} (checked {attempts} times) — SSL skipped. \
         If the record is proxied (Cloudflare orange cloud), it never will: turn the proxy off \
         for issuance, or terminate TLS at the proxy instead."
    )
}

/// Параметры провижининга, вычитанные до открытия SSH.
struct ProvisionPlan<'a> {
    domain_id: &'a str,
    domain_name: &'a str,
    /// IP сервера — он же ожидаемый ответ DNS перед выпуском SSL.
    host: &'a str,
    php_version: &'a str,
    site_user_existing: Option<String>,
    site_only: bool,
    with_db: bool,
    /// Почта аккаунта для Let's Encrypt, прочитанная ДО открытия сессии:
    /// сетевой запрос посреди живого SSH — это молчание в канале, за которое
    /// russh может закрыть сессию (см. `PROVISION_SESSION_TIMEOUT`).
    le_email: Option<&'a str>,
    /// Почему `le_email` пуст — не запрашивали (`site_only`) или не получили.
    /// Читается только во второй ситуации: в первой до SSL дело не доходит.
    le_email_error: Option<&'a str>,
}

/// Что провижининг успел сделать внутри уже открытой сессии.
struct ProvisionSteps {
    site_user: String,
    site_path: String,
    steps: Vec<&'static str>,
    /// Прошёл ли preflight портов 80/443. Закрытый firewall — причина №1
    /// последующего провала HTTP-01, и без этого флага в аудите связать
    /// `ssl_error` с ним постфактум нечем.
    firewall_ok: bool,
    ssl_issued: Option<bool>,
    ssl_error: Option<String>,
    db: Option<DbOut>,
    ftp: Option<FtpOut>,
}

/// Имена шагов, которыми провижининг сообщает «создавать не пришлось».
///
/// Константы, а не литералы: одно и то же значение уходит и в `steps` аудита, и
/// в `provision:progress` (там его читает `PROVISION_STEP_LABEL` фронта), и в
/// сравнение ниже. Разъехавшись, они дали бы тост про создание там, где ничего
/// не создавалось.
const FTP_STEP_EXISTS: &str = "ftp_exists";
const DB_STEP_EXISTS: &str = "db_exists";

/// Перевод исхода создания БД в то, что уедет во фронт, и имя шага.
///
/// Вынесено из `run_provision_steps` ради проверяемости: сама она требует
/// `AppHandle` и живого SSH, а потерять здесь `database_exists` — ровно тот
/// класс ошибки, из-за которого модалка врала бы про существующую базу.
/// Подставить пароль варианту `Exists` тут нечем: поля нет.
fn db_outcome(created: DbCreation) -> (DbOut, &'static str) {
    match created {
        DbCreation::Created(CreateDbResult {
            db_name,
            db_user,
            db_password,
        }) => (
            DbOut::Created {
                db_name,
                db_user,
                db_password,
            },
            "db",
        ),
        DbCreation::AlreadyExists(ExistingDb {
            db_name,
            db_user,
            database_exists,
        }) => (
            DbOut::Exists {
                db_name,
                db_user,
                database_exists,
            },
            DB_STEP_EXISTS,
        ),
    }
}

/// То же для FTP-аккаунта.
fn ftp_outcome(created: FtpCreation) -> (FtpOut, &'static str) {
    match created {
        FtpCreation::Created(CreateFtpResult {
            ftp_user,
            ftp_password,
        }) => (
            FtpOut::Created {
                ftp_user,
                ftp_password,
            },
            "ftp",
        ),
        FtpCreation::AlreadyExists { ftp_user } => {
            (FtpOut::Exists { ftp_user }, FTP_STEP_EXISTS)
        }
    }
}

/// Шаги провижининга внутри уже открытой сессии.
///
/// Вынесено отдельно ровно затем же, зачем `run_fastpanel_install_steps`:
/// вызывающий закрывает сессию один раз на любом пути выхода. Каждый `?`
/// здесь — от `create_site` до `create_database` — иначе утекал бы соединением.
async fn run_provision_steps(
    app: &AppHandle,
    session: &mut SshSession,
    plan: &ProvisionPlan<'_>,
) -> Result<ProvisionSteps, ProvisionFailure> {
    let domain_id = plan.domain_id;
    let domain_name = plan.domain_name;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": STEP_FASTPANEL_PATH, "domain_id": domain_id }),
    );
    let fp_path = fastpanel::get_fastpanel_path(session, None)
        .await
        .map_err(|e| ProvisionFailure::at(STEP_FASTPANEL_PATH, e))?
        .ok_or_else(|| {
            ProvisionFailure::known(
                STEP_FASTPANEL_PATH,
                CAUSE_NO_FASTPANEL,
                CommandError::Api("fastpanel binary not found on server".into()),
            )
        })?;

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": STEP_FIREWALL, "domain_id": domain_id }),
    );
    let ports = fastpanel::ensure_ports_open(session, &[80, 443])
        .await
        .map_err(|e| ProvisionFailure::at(STEP_FIREWALL, e))?;
    if !ports.success {
        // Закрытые 80/443 — причина №1 будущего провала HTTP-01. В лог этого
        // мало: пользователь увидит только невнятный ssl_error через минуту.
        tracing::warn!(target: "provision", "firewall preflight: {:?}", ports.error);
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({
                "step": "firewall_warning",
                "domain_id": domain_id,
                "firewall": ports.firewall,
                "error": ports.error,
            }),
        );
    }

    // Переиспользование существующего сайта и его создание — разные события, и
    // аудит не должен называть первое вторым.
    let (site, site_reused) = if let Some(ref u) = plan.site_user_existing {
        if fastpanel::site_exists(session, u, domain_name)
            .await
            .map_err(|e| ProvisionFailure::at(STEP_CREATE_SITE, e))?
        {
            (
                CreateSiteResult {
                    site_user: u.clone(),
                    site_path: format!("/var/www/{u}/data/www/{domain_name}"),
                },
                true,
            )
        } else {
            (
                fastpanel::create_site(session, &fp_path, domain_name, plan.php_version)
                    .await
                    .map_err(|e| ProvisionFailure::at(STEP_CREATE_SITE, e))?,
                false,
            )
        }
    } else {
        (
            fastpanel::create_site(session, &fp_path, domain_name, plan.php_version)
                .await
                .map_err(|e| ProvisionFailure::at(STEP_CREATE_SITE, e))?,
            false,
        )
    };

    let site_step = if site_reused {
        "site_exists"
    } else {
        STEP_CREATE_SITE
    };
    let mut done = ProvisionSteps {
        site_user: site.site_user,
        site_path: site.site_path,
        steps: vec!["ssh", site_step],
        firewall_ok: ports.success,
        ssl_issued: None,
        ssl_error: None,
        db: None,
        ftp: None,
    };

    if !plan.site_only {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": STEP_FTP, "domain_id": domain_id }),
        );
        // Пароль FTP генерируется на сервере и нигде больше не хранится: не
        // отдав его в ответе, мы оставляем пользователя с аккаунтом, войти в
        // который он не сможет никогда. Поэтому он живёт в `done.ftp` до
        // возврата результата — ровно как пароль БД ниже.
        //
        // `output` (сырой вывод команды) отбрасываем прямо в деструктуризации,
        // как и у `create_database`: пользы в нём нет, а гарантий, что FastPanel
        // не повторит в нём пароль, — тоже.
        //
        // Существующий аккаунт — не создание: у `FtpCreation::AlreadyExists`
        // пароля нет физически, и выдать его за созданный нечем. Пароль такого
        // аккаунта был показан один раз тем прогоном, который его создал.
        let (ftp, ftp_step) = ftp_outcome(
            fastpanel::create_ftp_account(session, &fp_path, domain_name)
                .await
                .map_err(|e| ProvisionFailure::at(STEP_FTP, e))?,
        );
        if ftp_step == FTP_STEP_EXISTS {
            // Про создание пользователь уже предупреждён шагом выше; здесь
            // сообщаем новость — создавать не пришлось.
            let _ = app.emit(
                "provision:progress",
                serde_json::json!({ "step": FTP_STEP_EXISTS, "domain_id": domain_id }),
            );
        }
        done.ftp = Some(ftp);
        done.steps.push(ftp_step);

        // SSL. Ни один путь этого блока не возвращает Err: сайт и FTP уже
        // созданы, и провалить из-за них весь provision значило бы отрапортовать
        // неудачу об удавшейся работе, а на повторе заново прогонять create_site.
        // Причина неудачи уезжает во фронт в `ssl_error`.
        //
        // Идемпотентность (принцип 4): у Let's Encrypt лимит дубликатов — 5
        // одинаковых сертификатов в неделю, он выгорает куда быстрее прочих, а
        // повторный provision домена штука обычная. Поэтому рабочий сертификат
        // не перевыпускаем.
        //
        // Но пропускать выпуск можно только там, где сайт переиспользован. Если
        // мы сейчас создали vhost заново, он про старый сертификат ничего не
        // знает, а файлы в /etc/letsencrypt/live переживают удаление сайта:
        // «файл есть» означало бы `ssl_issued: true` на сайте, который навсегда
        // остался бы на голом HTTP, причём повторный provision это не чинил бы.
        //
        // Известный зазор: certbot кладёт дубликаты в `live/{domain}-0001`, а
        // смотрим мы только на `live/{domain}` — то есть на самый старый набор.
        // Для решения «перевыпускать ли» это безопасная сторона ошибки.
        let reuse_existing_cert = if site_reused {
            match fastpanel::read_ssl_info(session, domain_name).await {
                Ok(info) => cert_good_enough(&info, chrono::Utc::now()),
                // Не смогли проверить — не повод падать: пойдём обычным путём, и
                // если сессия действительно мертва, это поймает ветка issue ниже.
                Err(e) => {
                    tracing::warn!(target: "provision", "ssl info check failed: {e}");
                    false
                }
            }
        } else {
            false
        };
        if reuse_existing_cert {
            let _ = app.emit(
                "provision:progress",
                serde_json::json!({ "step": "ssl_exists", "domain_id": domain_id }),
            );
            done.ssl_issued = Some(true);
            done.steps.push("ssl_exists");
        } else {
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
                // Домен не смотрит на сервер: Let's Encrypt не пройдёт HTTP-01,
                // и дёргать его сейчас — только жечь rate limit.
                let _ = app.emit(
                    "provision:progress",
                    serde_json::json!({ "step": "ssl_skipped_dns", "domain_id": domain_id }),
                );
                done.ssl_issued = Some(false);
                done.ssl_error = Some(dns_gate_message(domain_name, plan.host, SSL_DNS_ATTEMPTS));
            } else {
                match plan.le_email {
                    // Почту читали до сессии и не прочитали. Не повод валить
                    // provision: это сетевой сбой, к состоянию сервера
                    // отношения не имеющий.
                    None => {
                        let _ = app.emit(
                            "provision:progress",
                            serde_json::json!({
                                "step": "ssl_skipped_no_email",
                                "domain_id": domain_id,
                            }),
                        );
                        done.ssl_issued = Some(false);
                        done.ssl_error = Some(
                            plan.le_email_error
                                .unwrap_or("no account email for Let's Encrypt")
                                .to_string(),
                        );
                    }
                    Some(email) => {
                        let _ = app.emit(
                            "provision:progress",
                            serde_json::json!({ "step": "ssl_issue", "domain_id": domain_id }),
                        );
                        match fastpanel::issue_ssl_certificate(
                            session,
                            &fp_path,
                            domain_name,
                            email,
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
                                done.ssl_error =
                                    Some(tail_lines(&e.to_string(), SSL_ERROR_TAIL_LINES));
                            }
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
            serde_json::json!({ "step": STEP_DB, "domain_id": domain_id }),
        );
        // `output` из CreateDbResult отбрасываем здесь же: в fallback-ветке это
        // вывод mysql, в котором повторён CREATE USER ... IDENTIFIED BY.
        //
        // Существующая пара «база + пользователь» приходит отдельным вариантом и
        // без пароля: у уже созданного пользователя он свой, выданный тем
        // прогоном, и `CREATE USER` его не меняет.
        let (db, db_step) = db_outcome(
            fastpanel::create_database(session, &fp_path, domain_name, None, None)
                .await
                .map_err(ProvisionFailure::db)?,
        );
        if db_step == DB_STEP_EXISTS {
            let _ = app.emit(
                "provision:progress",
                serde_json::json!({ "step": DB_STEP_EXISTS, "domain_id": domain_id }),
            );
        }
        done.steps.push(db_step);
        done.db = Some(db);
    }

    Ok(done)
}

/// Значения статусов из `backend/app/core/constants.py` (`SslStatus`,
/// `FastPanelStatus`). Свои строки придумывать нельзя: их читают серверные
/// проверки и фронт.
const SSL_STATUS_ACTIVE: &str = "active";
const SSL_STATUS_ERROR: &str = "error";
const FASTPANEL_STATUS_INSTALLED: &str = "installed";
/// Из словаря `DomainStatus` бэкенда. `failed` читает и бейдж строки, и фильтр
/// «FAILED», и CSV-экспорт упавших — до этой фазы его не ставил никто.
const DOMAIN_STATUS_FAILED: &str = "failed";
const DOMAIN_STATUS_ACTIVE: &str = "active";
const DOMAIN_STATUS_SITE_CREATED: &str = "site_created";

/// Ширины колонок из `backend/app/models/domain.py` и
/// `backend/app/models/server.py`. Перелив там даёт не 422, а ошибку БД.
const MAX_SITE_USER: usize = 64;
const MAX_SITE_PATH: usize = 255;
const MAX_DB_NAME: usize = 64;
const MAX_DB_USER: usize = 64;
const MAX_FASTPANEL_URL: usize = 512;
const MAX_FASTPANEL_USER: usize = 128;

/// Значение, если оно помещается в колонку сервера, иначе `None`.
///
/// Обрезать нельзя: обрезанный `site_user` или путь читались бы дальше как
/// правда — и провижининг по ним промахнулся бы мимо реального сайта. Роняя
/// одно поле, мы сохраняем остальные: 500 от БД утопил бы весь write-back.
///
/// `id` — домена или сервера: в bulk-прогоне на 200 доменов варнинг без него
/// не говорит, у кого именно поле не записалось.
fn fit_or_omit(id: &str, field: &str, value: &str, max: usize) -> Option<String> {
    if value.chars().count() > max {
        tracing::warn!(
            target: "provision",
            "write-back for {id}: {field} longer than {max} chars, field omitted"
        );
        None
    } else {
        Some(value.to_string())
    }
}

/// Что из результата провижининга уезжает на сервер.
///
/// Пароли БД и FTP сюда не попадают физически: в `DomainWriteBack` нет полей,
/// куда их можно было бы положить. Это и есть инвариант ZK — сервер получает
/// метаданные, секреты остаются на клиенте.
///
/// `ssl_status`:
/// * `Some(true)` → `active`;
/// * `Some(false)` → `error` — и провал выпуска, и пропуск из-за DNS/почты.
///   `pending` не годится: он означает «выпуск идёт», а после возврата команды
///   никто его не завершит; причину пользователь видит в `ssl_error` ответа;
/// * `None` → SSL не пробовали вовсе (`site_only`), и поле опускаем: записать
///   `none` значило бы стереть настоящий `active` от прошлого прогона.
///
/// `last_provision_error` гасим явным `null`: провижининг дошёл до конца, и
/// ошибка прошлого прогона больше не описывает состояние домена. Текст
/// `ssl_error` на сервер не отправляем — это вывод certbot, ровно как и в
/// метаданных аудита, который его тоже не берёт.
///
/// `status` — по той же причине, что и `null` в ошибке: домен, помеченный
/// `failed` прошлым прогоном, обязан перестать быть `failed`, иначе бейдж
/// строки навсегда красный при пустой ошибке. `active` — только когда
/// сертификат действительно есть, `site_created` — когда SSL пробовали и не
/// вышло.
///
/// Когда SSL не пробовали вовсе (`site_only`), статус разбирается по прошлому:
/// `failed` гасим в `site_created`, а всё остальное не трогаем. Записывать
/// `site_created` безусловно значило бы понижать живой `active` за один
/// site-only повтор, а знания про SSL у этого прогона нет никакой — он его не
/// запрашивал.
///
/// Прошлый статус берётся здесь же, из строки локального кэша (`domain_row` —
/// та самая, откуда прочитаны `site_user` и `php_version`), а не приходит
/// готовым аргументом: так всё решение «что делать со статусом» лежит внутри
/// одной функции, которую можно поднять в тесте. Вынесенное к вызывающему
/// чтение осталось бы в непокрываемой части (`provision_domain_inner` требует
/// keychain и живого SSH), и мутация «читать не оттуда» была бы незаметна.
fn domain_write_back_body(
    r: &ProvisionResultOut,
    domain_row: &serde_json::Value,
) -> DomainWriteBack {
    let id = r.domain_id.as_str();
    let previous_status = domain_row.get("status").and_then(json_str);
    DomainWriteBack {
        status: match r.ssl_issued {
            Some(true) => Some(DOMAIN_STATUS_ACTIVE.to_string()),
            Some(false) => Some(DOMAIN_STATUS_SITE_CREATED.to_string()),
            None => (previous_status.as_deref() == Some(DOMAIN_STATUS_FAILED))
                .then(|| DOMAIN_STATUS_SITE_CREATED.to_string()),
        },
        site_user: fit_or_omit(id, "site_user", &r.site_user, MAX_SITE_USER),
        site_path: fit_or_omit(id, "site_path", &r.site_path, MAX_SITE_PATH),
        ssl_status: r.ssl_issued.map(|ok| {
            if ok {
                SSL_STATUS_ACTIVE.to_string()
            } else {
                SSL_STATUS_ERROR.to_string()
            }
        }),
        // Имена уезжают и тогда, когда база уже существовала: это правда о
        // домене, а не отчёт о работе, и прошлый прогон мог их не записать.
        // Но ровно настолько, насколько это правда: имя базы, которой нет,
        // не пишем (см. `db_name_if_present`).
        db_name: r
            .db
            .as_ref()
            .and_then(|d| d.db_name_if_present())
            .and_then(|n| fit_or_omit(id, "db_name", n, MAX_DB_NAME)),
        db_user: r
            .db
            .as_ref()
            .and_then(|d| fit_or_omit(id, "db_user", d.db_user(), MAX_DB_USER)),
        // Зону провижининг не заводит: её пишет `domain_full_setup`.
        cloudflare_zone_id: None,
        // Провижининг NS не трогает: их ставит `registrar_set_nameservers`.
        ns_status: None,
        last_provision_error: Some(None),
    }
}

/// Что уезжает на сервер о ПРОВАЛИВШЕМСЯ прогоне.
///
/// Ровно два поля. Остальные опущены намеренно: сервер применяет патч через
/// `exclude_unset`, и всё, чего здесь нет, он не трогает — упавший прогон не
/// вправе стирать `site_user`, `db_name` и прочую правду, добытую удачным
/// прогоном до него. Своё же `null` в `last_provision_error` ставит только
/// удачный прогон (`domain_write_back_body`), и это единственный способ погасить
/// эту ошибку — второй упавший прогон её перепишет, но не сотрёт.
///
/// В тексте — только шаг и класс причины (см. `ProvisionFailure::server_text`):
/// вывод команды, в котором FastPanel повторяет argv, на сервер не уходит.
fn domain_failure_write_back_body(f: &ProvisionFailure) -> DomainWriteBack {
    DomainWriteBack {
        status: Some(DOMAIN_STATUS_FAILED.to_string()),
        last_provision_error: Some(Some(f.server_text())),
        ..Default::default()
    }
}

/// Что из результата установки FastPanel уезжает на сервер.
///
/// Пароля панели в `ServerWriteBack` нет по той же причине, что и паролей БД:
/// его негде разместить. Статус ставим `installed` — именно его читает проверка
/// идемпотентности в [`install_fastpanel`]. Не разобранные из вывода URL и логин
/// опускаем: панель установлена и без них, а `null` затёр бы прошлые значения.
fn server_write_back_body(r: &InstallFastpanelResult) -> ServerWriteBack {
    ServerWriteBack {
        fastpanel_status: Some(FASTPANEL_STATUS_INSTALLED.to_string()),
        fastpanel_url: r
            .url
            .as_deref()
            .and_then(|v| fit_or_omit(&r.server_id, "fastpanel_url", v, MAX_FASTPANEL_URL)),
        fastpanel_user: r
            .user
            .as_deref()
            .and_then(|v| fit_or_omit(&r.server_id, "fastpanel_user", v, MAX_FASTPANEL_USER)),
    }
}

/// Записать провал write-back'а в лог и сказать вызывающему, надо ли сообщать
/// о нём наружу: `true` — не записалось.
///
/// Возвращает `bool`, а не `Result`, намеренно: работа на сервере уже сделана,
/// а пароли БД/FTP/панели существуют только в ответе команды. Уронить её из-за
/// незаписанных метаданных значило бы потерять их навсегда из-за сетевого сбоя
/// на последнем шаге. Не превращать в `?`.
fn log_write_back_failure(kind: &str, r: Result<(), ApiError>) -> bool {
    match r {
        Ok(()) => false,
        Err(e) => {
            tracing::warn!(target: "provision", "write-back of {kind} result failed: {e}");
            true
        }
    }
}

/// Записать провал провижининга в домен — чтобы упавший прогон было видно.
/// Возвращает `true`, если записать не удалось (об этом надо сказать наружу).
///
/// Best-effort, как и write-back успеха, и по более узкой причине: сеть могла
/// отвалиться вместе с самим провижинингом, а `?` здесь подменил бы причину
/// провала («ssh: auth failed») на «write-back failed» — то есть потерял бы ту
/// самую ошибку, которую пришли записать. Поэтому провал записи только
/// логируется, а наружу возвращается исходная ошибка. Не превращать в `?`.
///
/// Без `AppHandle` намеренно: событие прогресса шлёт вызывающий, а сюда не
/// приходит ничего, чего нельзя поднять в тесте, — и тогда проверяется ЭФФЕКТ
/// (что реально ушло на сервер), а не факт вызова.
async fn record_provision_failure(api: &ApiClient, domain_id: &str, f: &ProvisionFailure) -> bool {
    log_write_back_failure(
        "domain failure",
        api.domain_write_back(domain_id, &domain_failure_write_back_body(f))
            .await,
    )
}

/// Разбор исхода провижининга: что уходит на сервер и что — наружу.
/// Второй элемент — `true`, если ошибку не удалось записать.
///
/// Отдельная функция и без `AppHandle` намеренно, по тому же правилу, что и
/// `record_provision_failure`: именно ЗДЕСЬ живёт связка «прогон упал → ошибка
/// уехала в домен», ради которой вся фаза. Оставшись строчкой внутри
/// `run_provision_domain` (а та требует Tauri-харнесса, которого в крейте нет),
/// она была бы непокрытой — и мутация «не звать запись» осталась бы зелёной,
/// как это дважды случалось в фазах 3a и 3b.
async fn finish_provision(
    api: &ApiClient,
    domain_id: &str,
    outcome: Result<ProvisionResultOut, ProvisionFailure>,
) -> (Result<ProvisionResultOut, CommandError>, bool) {
    match outcome {
        Ok(result) => (Ok(result), false),
        Err(f) => {
            let write_back_failed = record_provision_failure(api, domain_id, &f).await;
            // Наружу — полный текст, включая вывод упавшей команды: он остаётся
            // на этой машине, и чинить пользователю нечем, кроме него.
            (Err(f.error), write_back_failed)
        }
    }
}

/// Провижининг домена целиком, с записью провала на сервер.
///
/// Разделено на функции не ради красоты: раньше `?` уносил управление ДО блока
/// write-back, поэтому упавший прогон не записывал ничего — «Last error» в UI
/// был вечным «—», а колонка `last_provision_error`, бейдж `FAILED` и
/// CSV-экспорт упавших не могли сработать в принципе. Теперь единственный выход
/// с ошибкой проходит через `finish_provision`, и обойти его нельзя, не изменив
/// тип: `provision_domain_inner` отдаёт `ProvisionFailure`, а наружу нужен
/// `CommandError`.
pub async fn run_provision_domain(
    app: &AppHandle,
    user_id: &str,
    domain_id: &str,
    site_only: bool,
    with_db: bool,
    cache_path: &Path,
    api: &ApiClient,
) -> Result<ProvisionResultOut, CommandError> {
    let outcome =
        provision_domain_inner(app, user_id, domain_id, site_only, with_db, cache_path, api).await;
    let (result, write_back_failed) = finish_provision(api, domain_id, outcome).await;
    if write_back_failed {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "writeback_failed", "domain_id": domain_id }),
        );
    }
    result
}

async fn provision_domain_inner(
    app: &AppHandle,
    user_id: &str,
    domain_id: &str,
    site_only: bool,
    with_db: bool,
    cache_path: &Path,
    api: &ApiClient,
) -> Result<ProvisionResultOut, ProvisionFailure> {
    let mut key = keychain::load_master_key(user_id)
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

    let mut password = blob_plaintext(api, &key, &blob_id).await?;
    // Мастер-ключ больше не нужен: дальше только SSH и HTTP. Раньше он жил до
    // конца функции, а она теперь тянется все минуты провижининга.
    key.zeroize();
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

    // Почта для Let's Encrypt — до открытия сессии. Внутри неё этот HTTP-запрос
    // был бы паузой в тишину канала, а провал остаётся не фатальным: без почты
    // просто не будет SSL.
    let le_email = if site_only {
        Err("ssl not requested (site_only)".to_string())
    } else {
        api.me().await.map(|me| me.email).map_err(|e| {
            tracing::warn!(target: "provision", "no account email for LE: {e}");
            tail_lines(
                &format!("could not read account email for Let's Encrypt: {e}"),
                SSL_ERROR_TAIL_LINES,
            )
        })
    };

    let _ = app.emit(
        "provision:progress",
        serde_json::json!({ "step": STEP_SSH_CONNECT, "domain_id": domain_id }),
    );

    let session = ssh_connect_session_with_timeout(
        app,
        &host,
        port,
        &ssh_user,
        &password,
        PROVISION_SESSION_TIMEOUT,
    )
    .await;
    // Пароль сервера дальше не нужен ни на одном пути — ни на успешном, ни на
    // ошибочном. Гасим до разбора результата, а не после.
    password.zeroize();
    let mut session = session.map_err(|e| ProvisionFailure::at(STEP_SSH_CONNECT, e))?;

    let plan = ProvisionPlan {
        domain_id,
        domain_name: &domain_name,
        host: &host,
        php_version: &php_version,
        site_user_existing,
        site_only,
        with_db,
        le_email: le_email.as_ref().ok().map(String::as_str),
        le_email_error: le_email.as_ref().err().map(String::as_str),
    };
    let stepped = run_provision_steps(app, &mut session, &plan).await;
    let _ = session.disconnect().await;
    let done = stepped?;

    let result = ProvisionResultOut {
        domain_id: domain_id.to_string(),
        site_user: done.site_user,
        site_path: done.site_path,
        ssl_issued: done.ssl_issued,
        ssl_error: done.ssl_error,
        db: done.db,
        ftp: done.ftp,
    };

    // Write-back несекретных результатов — раньше аудита, и намеренно: аудит
    // фиксирует, что действие было, а write-back делает состояние сервера
    // правдой. Из неё и вырастает идемпотентность следующего прогона: сам он
    // читает не сервер, а локальный SQLCipher-кэш (`get_row_fields` выше, где
    // берётся `site_user` для `site_exists`), но фронт зовёт провижининг через
    // `invokeSynced`, а тот перед каждым вызовом подтягивает изменения с
    // сервера. Не записав — не увидим и в кэше. Поэтому при частичном сбое
    // ценнее записать состояние, чем строчку в журнале. К тому же сам PUT
    // оставляет на сервере запись `domain.update`, так что действие не пропадёт
    // из аудита совсем.
    //
    // Как и аудит, write-back — best-effort: см. `log_write_back_failure`.
    if log_write_back_failure(
        "domain",
        api.domain_write_back(domain_id, &domain_write_back_body(&result, &domain_row))
            .await,
    ) {
        let _ = app.emit(
            "provision:progress",
            serde_json::json!({ "step": "writeback_failed", "domain_id": domain_id }),
        );
    }

    // metadata без секретов: ни пароля БД, ни FTP, ни текста ssl_error (это
    // вывод certbot, и он всё равно длинный). Redaction guard аудита в http.rs —
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
                "with_db": with_db,
                "firewall_ok": done.firewall_ok,
                "ssl_issued": result.ssl_issued,
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

    Ok(result)
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

/// Массовый прогон создаёт сайт ЦЕЛИКОМ, а не только каталог.
///
/// Именованная константа, а не литерал в вызове: `site_only` и `with_db` стоят
/// в сигнатуре `run_provision_domain` соседними позиционными `bool`, и
/// перепутать их местами нечем. При этом `site_only: true` означал бы, что
/// FTP-аккаунты не создаются вообще — то есть весь массовый прогон делает вид,
/// что работает. Тестового харнесса на прод-проводку команды нет (нужен Tauri
/// `State`), так что единственная защита — читаемость диффа.
const BULK_SITE_ONLY: bool = false;

/// Базу массовый прогон не создаёт: у ссылки `sdmp://bulk-provision` нет
/// параметра «создавать ли базу», а решить за пользователя значит создать
/// артефакт, которого он не просил.
const BULK_WITH_DB: bool = false;

/// Через сколько часов строку `running` считаем осиротевшей.
///
/// `running` снимается только двумя явными ветками ВНУТРИ процесса, поэтому его
/// смерть (краш, `Cmd+Q`, ребут — а на сотне доменов прогон идёт часами)
/// оставляет строку навсегда, и повтор того же набора до скончания века
/// упирается в `already_ran`. Восстановиться было нельзя ничем, кроме как
/// изменить набор доменов.
///
/// Порог обязан быть заведомо больше самого долгого правдоподобного прогона:
/// снять его рано — значит запустить второй прогон параллельно живому первому.
/// Сутки означают, что приложение должно простоять 24 часа с незакрытым
/// прогоном, чтобы это стало ложным срабатыванием. Цена ошибки при этом
/// ограничена: `site_exists`/`ssl_exists`/`ftp_exists`/`db_exists` делают повтор
/// по уже сделанному домену холостым (с оговоркой про «проверка не ответила» —
/// см. комментарий у `bulk_run_complete` ниже).
const BULK_RUN_STALE_AFTER_HOURS: i64 = 24;

/// Осиротела ли строка `running`.
///
/// Не смогли разобрать дату — считаем, что НЕ осиротела. Ошибка в эту сторону
/// оставляет пользователя с застрявшим ключом (чинится сменой набора), а в
/// обратную — запускает второй прогон поверх живого первого.
fn bulk_run_is_stale(run: &cache::BulkRun, now: chrono::DateTime<chrono::Utc>) -> bool {
    match chrono::NaiveDateTime::parse_from_str(&run.created_at, "%Y-%m-%d %H:%M:%S") {
        Ok(started) => {
            let started = started.and_utc();
            now - started > chrono::Duration::hours(BULK_RUN_STALE_AFTER_HOURS)
        }
        Err(_) => false,
    }
}

/// Массовый прогон поверх произвольного исполнителя одного домена.
///
/// Вынесено из команды не ради красоты: главный вопрос этой функции — «что
/// вернуть, когда прогон оборвался на середине» — проверяется тестом по
/// эффекту (что пришло наружу и что легло в `bulk_runs`), а поднять ради этого
/// живой SSH нельзя.
///
/// Возвращает `Err` только там, где ничего ещё не выполнялось (не прочитали или
/// не смогли открыть строку прогона). Как только первый домен запущен, любой
/// исход — это `Ok(BulkProvisionOut)`: результаты уже созданных FTP-аккаунтов
/// дороже, чем удобство `?` у вызывающего.
async fn run_bulk_provision<F, Fut>(
    conn: &mut rusqlite::Connection,
    key: &str,
    domain_ids: &[String],
    mut run_one: F,
    emit: impl Fn(&str, &str),
) -> Result<BulkProvisionOut, CommandError>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<ProvisionResultOut, CommandError>>,
{
    let skipped_all = || {
        domain_ids
            .iter()
            .map(|d| BulkProvisionItem {
                domain_id: d.clone(),
                outcome: BulkItemOutcome::Skipped,
            })
            .collect::<Vec<_>>()
    };

    if let Some(run) =
        cache::bulk_run_status(conn, key).map_err(|e| CommandError::Api(e.to_string()))?
    {
        // `done` блокирует всегда: этот набор действительно прошёл целиком.
        // `running` — только пока не осиротел (см. `bulk_run_is_stale`).
        let blocks = run.status == "done"
            || (run.status == "running" && !bulk_run_is_stale(&run, chrono::Utc::now()));
        if blocks {
            // Раньше здесь возвращался голый ключ, и вызывающий не мог отличить
            // «всё прошло» от «прогон уже был, результатов у меня нет». Пароли
            // показываются ровно один раз и нигде не хранятся, так что второй
            // раз их не покажет никто — это надо сказать словами, а не выдать
            // за пустой успех. И сказать РАЗНЫМИ словами про `running` и `done`.
            return Ok(BulkProvisionOut {
                idempotency_key: key.to_string(),
                status: BulkRunStatus::AlreadyRan,
                error: None,
                previous_status: Some(run.status),
                items: skipped_all(),
            });
        }
    }
    cache::bulk_run_upsert_start(
        conn,
        key,
        "provision_bulk",
        &serde_json::to_string(domain_ids).unwrap_or_default(),
    )
    .map_err(|e| CommandError::Api(e.to_string()))?;

    let mut items: Vec<BulkProvisionItem> = Vec::with_capacity(domain_ids.len());
    for (i, did) in domain_ids.iter().enumerate() {
        emit("bulk_item", did);
        match run_one(did.clone()).await {
            Ok(result) => items.push(BulkProvisionItem {
                domain_id: did.clone(),
                outcome: BulkItemOutcome::Done { result },
            }),
            Err(e) => {
                // Останавливаемся на первой ошибке, а не идём по списку дальше.
                // Причина: почти всякий провал массового прогона системный —
                // запертый keychain, недоступный сервер, протухшие креды, — и
                // тогда «идти дальше» означает N × минуты SSH-таймаутов, прежде
                // чем пользователь узнает хоть что-то. Цена решения снята:
                // оставшиеся домены помечены `Skipped` поимённо, а всё, что
                // успело создаться, уезжает наружу вместе с ошибкой — повтор
                // запускается ровно по нужному хвосту.
                //
                // Секретов в тексте нет: пароль БД гасит `db_error`, вывод
                // команд с паролями в argv — `opaque_exit`, SSL до ошибки не
                // доходит вовсе.
                let detail = format!("failed on domain {did}: {e}");
                items.push(BulkProvisionItem {
                    domain_id: did.clone(),
                    outcome: BulkItemOutcome::Failed {
                        error: e.to_string(),
                    },
                });
                for rest in &domain_ids[i + 1..] {
                    items.push(BulkProvisionItem {
                        domain_id: rest.clone(),
                        outcome: BulkItemOutcome::Skipped,
                    });
                }
                // Строку нельзя оставить в `running`: guard выше на повторе
                // вернул бы `already_ran`, не сделав ничего, — пользователь жмёт
                // «повторить» и не получает ничего. Помечаем прогон failed,
                // чтобы повтор был возможен.
                if let Err(ce) = cache::bulk_run_fail(conn, key, &detail) {
                    tracing::warn!(target: "provision", "could not mark bulk run failed: {ce}");
                }
                emit("bulk_failed", did);
                return Ok(BulkProvisionOut {
                    idempotency_key: key.to_string(),
                    status: BulkRunStatus::Failed,
                    error: Some(detail),
                    previous_status: None,
                    items,
                });
            }
        }
    }
    if let Err(e) = cache::bulk_run_complete(conn, key, "ok") {
        // Тот же капкан, что и в цикле: не записав финальный статус, мы оставим
        // строку в `running`, и повтор вернёт `already_ran`, ничего не сделав.
        // Все домены при этом отработали — помечаем прогон failed сознательно:
        // залипший `running` чинится только временем (`BULK_RUN_STALE_AFTER_HOURS`),
        // а повторный прогон в норме холостой: каждый создающий шаг сперва
        // спрашивает, не сделано ли уже, — `site_exists`, `ssl_exists`,
        // `ftp_exists`, `db_exists` (`ssh/fastpanel.rs`), — и уже существующим
        // аккаунтам пароль не выдумывает: они приходят как `status: exists` без
        // пароля, потому что настоящий выдан один раз тем прогоном, который их
        // создал.
        //
        // «В норме» — не «всегда»: проверка может не ответить (нет подкоманды
        // `list`, нет доступа к `mysql.user`), и тогда создающая команда всё-таки
        // уходит на сервер. От выдуманного пароля там защищает уже не она, а
        // вторая линия — ошибка 1396 у `CREATE USER` без `IF NOT EXISTS` и
        // разбор текста ошибки создания. Остаётся щель, которую без живого
        // сервера не закрыть: проверка не ответила И создающая команда вернула
        // 0 (у FastPanel CLI аналога 1396 нет).
        //
        // Но результаты при этом НЕ теряем: раньше здесь стоял `return Err`, и
        // сбой записи статуса уносил пароли всех отработавших доменов.
        tracing::warn!(target: "provision", "could not mark bulk run done: {e}");
        let _ = cache::bulk_run_fail(conn, key, "all domains done, status write failed");
        return Ok(BulkProvisionOut {
            idempotency_key: key.to_string(),
            status: BulkRunStatus::Failed,
            error: Some(format!(
                "all domains finished, but the run status could not be saved: {e}"
            )),
            previous_status: None,
            items,
        });
    }
    Ok(BulkProvisionOut {
        idempotency_key: key.to_string(),
        status: BulkRunStatus::Ok,
        error: None,
        previous_status: None,
        items,
    })
}

#[tauri::command]
pub async fn provision_bulk(
    app: AppHandle,
    user_id: String,
    domain_ids: Vec<String>,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
) -> Result<BulkProvisionOut, CommandError> {
    let key = idempotency_key("provision_bulk", &domain_ids);
    let cache_path = cache_path(&handle)?;
    let mut mk = keychain::load_master_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    // `mut` и передача по `&mut` — не стиль: `&Connection` не `Send`, а фьючер
    // Tauri-команды обязан быть `Send`. `&mut Connection` — `Send`, потому что
    // `Connection: Send`.
    let mut conn = cache::open(&cache_path, &mk).map_err(|e| CommandError::Api(e.to_string()))?;
    // Ключ нужен ровно на открытие кэша. Дальше идёт цикл на N × минуты (для
    // настоящего bulk — часы), а `run_provision_domain` внутри гасит свою копию
    // за секунды — держать здесь ещё одну всё это время бессмысленно.
    mk.zeroize();

    let app_ref = &app;
    let user_ref = user_id.as_str();
    let path_ref = cache_path.as_path();
    let api_ref: &ApiClient = &api;
    run_bulk_provision(
        &mut conn,
        &key,
        &domain_ids,
        move |did: String| async move {
            run_provision_domain(
                app_ref,
                user_ref,
                &did,
                BULK_SITE_ONLY,
                BULK_WITH_DB,
                path_ref,
                api_ref,
            )
            .await
        },
        |step, did| {
            let _ = app.emit(
                "provision:progress",
                serde_json::json!({ "step": step, "domain_id": did }),
            );
        },
    )
    .await
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
    let mut key = keychain::load_master_key(&user_id)
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
    let password = blob_plaintext(&api, &key, &blob_id).await;
    // Мастер-ключ больше не нужен: дальше только SSH и HTTP, а функция тянется
    // все 30-40 минут установки. Гасим до разбора результата, а не после.
    key.zeroize();
    let mut password = password?;
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
    let session = ssh_connect_session_with_timeout(
        &app,
        &host,
        port,
        &ssh_user,
        &password,
        FP_SESSION_TIMEOUT,
    )
    .await;
    // Пароль сервера дальше не нужен ни на одном пути — ни на успешном, ни на
    // ошибочном. Гасим до разбора результата, а не после.
    password.zeroize();
    let mut session = session?;

    let installed = run_fastpanel_install_steps(&app, &mut session, &server_id, &os).await;
    let _ = session.disconnect().await;
    let creds = installed?;

    let result = InstallFastpanelResult {
        server_id,
        url: creds.url,
        user: creds.user,
        password: creds.password,
    };

    // Write-back раньше аудита — по той же причине, что и в провижининге.
    // `fastpanel_status = installed` читает проверка идемпотентности в начале
    // этой самой команды; читает она локальный кэш (`get_row_fields` выше), но
    // значение попадает туда только из серверной колонки, которую заполняет вот
    // этот PUT, а подтягивает её `invokeSynced` перед каждым вызовом. Не
    // записав, мы получили бы переустановку панели поверх рабочей.
    // Best-effort: см. `log_write_back_failure`.
    if log_write_back_failure(
        "server",
        api.server_write_back(&result.server_id, &server_write_back_body(&result))
            .await,
    ) {
        let _ = app.emit(
            "fastpanel:progress",
            serde_json::json!({ "step": "writeback_failed", "server_id": result.server_id }),
        );
    }

    // metadata без пароля (redaction guard аудита в http.rs — debug_assert, в
    // release его нет, поэтому чистота метаданных обеспечивается здесь).
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
            Some(&result.server_id),
            device_id,
            Some(serde_json::json!({ "url": result.url, "user": result.user })),
        )
        .await
    {
        tracing::warn!(target: "provision", "audit log for fastpanel_install failed: {e}");
        let _ = app.emit(
            "fastpanel:progress",
            serde_json::json!({ "step": "audit_failed", "server_id": result.server_id }),
        );
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Строка домена из локального кэша с заданным прошлым статусом. Матрица
    /// «что делать со статусом» — в `a_finished_run_takes_the_domain_out_of_failed`;
    /// тестам, которым статус безразличен, достаётся `cached("new")` — свежий
    /// домен, каким его создаёт `POST /domains`.
    fn cached(status: &str) -> serde_json::Value {
        serde_json::json!({ "status": status })
    }

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
        let e = exec_error("fastpanel installer", FP_INSTALL_TIMEOUT, auth_err());
        // Начало текста: хвост `SshError::Auth` — диагностика для человека.
        assert!(e.to_string().starts_with("ssh: auth failed"), "{e}");
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
        assert!(!e.to_string().contains("sup3rSecret"), "{e}");
        assert!(!e.to_string().contains("CREATE USER"), "{e}");
    }

    #[test]
    fn db_error_names_the_timeout() {
        let e = db_error(SshError::Session("exec timeout".into()));
        assert!(e.to_string().contains("database creation timed out"));
    }

    // Причину, по которой вывод не показан, пользователь должен прочитать —
    // иначе «failed on the server» выглядит как проглоченная ошибка.
    #[test]
    fn db_error_says_why_the_output_is_withheld_and_what_to_do() {
        let msg = db_error(SshError::Session("boom".into())).to_string();
        assert!(msg.contains("withheld"), "{msg}");
        assert!(msg.contains("db password"), "{msg}");
        assert!(msg.contains("fastpanel database create"), "{msg}");
    }

    // Самый частый случай — проксирование Cloudflare, при котором домен
    // резолвится прекрасно, просто не в тот IP, и ждать бесполезно.
    #[test]
    fn dns_gate_message_names_domain_ip_attempts_and_the_proxy_trap() {
        let m = dns_gate_message("example.com", "203.0.113.7", 5);
        assert!(m.contains("example.com"), "{m}");
        assert!(m.contains("203.0.113.7"), "{m}");
        assert!(m.contains("5 times"), "{m}");
        assert!(m.to_lowercase().contains("cloudflare"), "{m}");
    }

    // Инвариант таймаутов: самый долгий отрезок тишины в сессии — exec выпуска
    // SSL плюс пауза сразу за ним — обязан уложиться в inactivity-таймаут.
    // Иначе умирает сессия, а не команда, и следующий шаг падает фатально.
    //
    // Ссылаемся на настоящие значения из ssh/fastpanel.rs, а не на копии: тест
    // должен падать и когда кто-то поднимет exec, а не только когда урежут
    // сессию. Второе — очевидная правка, первое — вероятная.
    #[test]
    fn session_timeout_outlives_the_longest_silence() {
        let longest_silence = fastpanel::SSL_ISSUE_EXEC_TIMEOUT + fastpanel::SSL_ISSUE_SETTLE;
        assert!(
            PROVISION_SESSION_TIMEOUT > longest_silence,
            "session {PROVISION_SESSION_TIMEOUT:?} must exceed longest silence {longest_silence:?}"
        );
        assert!(
            PROVISION_SESSION_TIMEOUT - longest_silence >= Duration::from_secs(60),
            "margin too thin: {PROVISION_SESSION_TIMEOUT:?} vs {longest_silence:?}"
        );
    }

    fn ssl_info(has: bool, expires_at: Option<chrono::DateTime<chrono::Utc>>) -> SslInfo {
        SslInfo {
            has_certificate: has,
            expires_at,
            issuer: None,
            is_letsencrypt: true,
            error: None,
        }
    }

    #[test]
    fn cert_good_enough_accepts_a_certificate_with_time_left() {
        let now = chrono::Utc::now();
        let info = ssl_info(true, Some(now + chrono::Duration::days(60)));
        assert!(cert_good_enough(&info, now));
    }

    // Просроченный сертификат — не «SSL уже есть»: пропустить выпуск значит
    // оставить сайт на нерабочем HTTPS.
    #[test]
    fn cert_good_enough_rejects_an_expired_certificate() {
        let now = chrono::Utc::now();
        let info = ssl_info(true, Some(now - chrono::Duration::days(1)));
        assert!(!cert_good_enough(&info, now));
    }

    // certbot продлевает за 30 дней; если осталось меньше суток, продление уже
    // сломано и выпускать надо сейчас.
    #[test]
    fn cert_good_enough_rejects_a_certificate_expiring_within_the_margin() {
        let now = chrono::Utc::now();
        let info = ssl_info(true, Some(now + chrono::Duration::hours(12)));
        assert!(!cert_good_enough(&info, now));
    }

    // Файл есть, а notAfter не разобрался — «не знаем» трактуем как «выпускать».
    #[test]
    fn cert_good_enough_rejects_a_certificate_with_unreadable_expiry() {
        let now = chrono::Utc::now();
        assert!(!cert_good_enough(&ssl_info(true, None), now));
    }

    #[test]
    fn cert_good_enough_rejects_a_missing_certificate() {
        let now = chrono::Utc::now();
        let info = ssl_info(false, Some(now + chrono::Duration::days(60)));
        assert!(!cert_good_enough(&info, now));
    }

    /// Отказ аутентификации для тестов. Поля обязательны с тех пор, как текст
    /// стал называть, под каким логином стучались, — см. `SshError::Auth`.
    fn auth_err() -> SshError {
        SshError::Auth {
            user: "root".into(),
            host: "10.0.0.1".into(),
            port: 22,
        }
    }

    // Варианты без вывода команды диагностику терять не должны.
    #[test]
    fn db_error_passes_through_errors_without_command_output() {
        // Начало текста, а не весь: хвост с логином и подсказкой — часть
        // диагностики для человека, и прибивать её ассертом значило бы
        // запретить её улучшать.
        assert!(db_error(auth_err()).to_string().starts_with("ssh: auth failed"), "{}", db_error(auth_err()));
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
            ftp: None,
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(!j.contains("ssl_issued"));
        assert!(!j.contains("ssl_error"));
        assert!(!j.contains("\"db\""));
        assert!(!j.contains("\"ftp\""));
    }

    #[test]
    fn provision_result_includes_db_when_present() {
        let r = ProvisionResultOut {
            domain_id: "1".into(),
            site_user: "u".into(),
            site_path: "/p".into(),
            ssl_issued: Some(true),
            ssl_error: None,
            db: Some(DbOut::Created {
                db_name: "d".into(),
                db_user: "du".into(),
                db_password: "dp".into(),
            }),
            ftp: None,
        };
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains("ssl_issued"));
        assert!(j.contains("db_name"));
    }

    fn full_result() -> ProvisionResultOut {
        ProvisionResultOut {
            domain_id: "42".into(),
            site_user: "u1".into(),
            site_path: "/var/www/u1/data/www/example.com".into(),
            ssl_issued: Some(true),
            ssl_error: None,
            db: Some(DbOut::Created {
                db_name: "u1_db".into(),
                db_user: "u1_dbu".into(),
                db_password: "dbP4ssw0rd".into(),
            }),
            ftp: Some(FtpOut::Created {
                ftp_user: "u1_ftp".into(),
                ftp_password: "ftpP4ssw0rd".into(),
            }),
        }
    }

    // Инвариант ZK, ради которого всё и затевалось: на сервер уезжают
    // метаданные, а пароли БД и FTP остаются только на клиенте. Проверяем
    // сериализованное тело, а не поля структуры: в сеть уходит именно оно.
    #[test]
    fn domain_write_back_body_never_carries_passwords() {
        let body =
            serde_json::to_string(&domain_write_back_body(&full_result(), &cached("new"))).unwrap();
        assert!(!body.contains("dbP4ssw0rd"), "{body}");
        assert!(!body.contains("ftpP4ssw0rd"), "{body}");
        assert!(!body.to_lowercase().contains("password"), "{body}");
        assert!(!body.contains("ftp_user"), "{body}");
        // Но метаданные, ради которых write-back и нужен, на месте.
        assert!(body.contains("\"site_user\":\"u1\""), "{body}");
        assert!(body.contains("\"db_name\":\"u1_db\""), "{body}");
        assert!(body.contains("\"db_user\":\"u1_dbu\""), "{body}");
    }

    // `exclude_unset` на сервере делает «поле опущено» и «поле = null» разными
    // операциями: null затёр бы имя базы, созданной прошлым прогоном.
    #[test]
    fn domain_write_back_body_omits_db_fields_when_no_database() {
        let mut r = full_result();
        r.db = None;
        let body = serde_json::to_string(&domain_write_back_body(&r, &cached("new"))).unwrap();
        assert!(!body.contains("db_name"), "{body}");
        assert!(!body.contains("db_user"), "{body}");
    }

    #[test]
    fn domain_write_back_body_maps_issued_ssl_to_active() {
        let b = domain_write_back_body(&full_result(), &cached("new"));
        assert_eq!(b.ssl_status.as_deref(), Some("active"));
    }

    #[test]
    fn domain_write_back_body_maps_failed_ssl_to_error() {
        let mut r = full_result();
        r.ssl_issued = Some(false);
        r.ssl_error = Some("dns gate".into());
        let b = domain_write_back_body(&r, &cached("new"));
        assert_eq!(b.ssl_status.as_deref(), Some("error"));
    }

    // `site_only` — единственный путь, оставляющий `ssl_issued: None`. Записать
    // тут "none" значило бы стереть настоящий "active" от прошлого прогона.
    #[test]
    fn domain_write_back_body_omits_ssl_status_when_ssl_was_not_attempted() {
        let mut r = full_result();
        r.ssl_issued = None;
        r.ssl_error = None;
        let body = serde_json::to_string(&domain_write_back_body(&r, &cached("new"))).unwrap();
        assert!(!body.contains("ssl_status"), "{body}");
    }

    // Провижининг дошёл до конца — прошлая ошибка больше не актуальна, и её
    // надо погасить явным null (опущенное поле сервер не тронет).
    #[test]
    fn domain_write_back_body_clears_a_stale_provision_error() {
        let body =
            serde_json::to_string(&domain_write_back_body(&full_result(), &cached("new"))).unwrap();
        assert!(body.contains("\"last_provision_error\":null"), "{body}");
    }

    // Колонки узкие (site_path — 255), и перелив даёт не 422, а ошибку БД,
    // которая утопит весь write-back. Обрезать нельзя — обрезанный путь читался
    // бы как правда; поэтому поле опускаем, остальные доезжают.
    #[test]
    fn domain_write_back_body_drops_an_over_long_site_path() {
        let mut r = full_result();
        r.site_path = "/var/www/".to_string() + &"a".repeat(300);
        let body = serde_json::to_string(&domain_write_back_body(&r, &cached("new"))).unwrap();
        assert!(!body.contains("site_path"), "{body}");
        assert!(body.contains("site_user"), "{body}");
    }

    // Пароль панели существует только в ответе команды: на сервер уходит лишь
    // статус, URL и логин.
    #[test]
    fn server_write_back_body_never_carries_the_panel_password() {
        let r = InstallFastpanelResult {
            server_id: "7".into(),
            url: Some("https://1.2.3.4:8888".into()),
            user: Some("fastuser".into()),
            password: Some("panelP4ssw0rd".into()),
        };
        let b = server_write_back_body(&r);
        assert_eq!(b.fastpanel_status.as_deref(), Some("installed"));
        let body = serde_json::to_string(&b).unwrap();
        assert!(!body.contains("panelP4ssw0rd"), "{body}");
        assert!(!body.to_lowercase().contains("password"), "{body}");
    }

    // Формат вывода инсталлятора мог измениться и креды не разобрались.
    // Панель при этом установлена — статус пишем, пустые поля опускаем.
    #[test]
    fn server_write_back_body_omits_unparsed_url_and_user() {
        let r = InstallFastpanelResult {
            server_id: "7".into(),
            url: None,
            user: None,
            password: None,
        };
        let body = serde_json::to_string(&server_write_back_body(&r)).unwrap();
        assert_eq!(body, "{\"fastpanel_status\":\"installed\"}");
    }

    // Здесь проверяется ровно одно: КАЖДЫЙ вид провала write-back'а (и не-2xx,
    // и сработавший ZK-guard) сворачивается в флаг «сообщить», а не в ошибку.
    //
    // То, что команда после этого действительно доживает до `Ok(result)`, тест
    // проверить не может: `run_provision_domain` и `install_fastpanel` требуют
    // AppHandle, keychain и живой SSH. Гарантия там структурная — оба вызова
    // (`if log_write_back_failure(...)` в `run_provision_domain` и в
    // `install_fastpanel`) не содержат `?`, а из `bool` его и не сделать.
    // Поэтому важно, чтобы функция не начала возвращать `Result`.
    #[test]
    fn every_write_back_failure_collapses_to_a_flag() {
        assert!(log_write_back_failure(
            "domain",
            Err(ApiError::Status {
                status: 500,
                body: "boom".into()
            })
        ));
        assert!(log_write_back_failure(
            "domain",
            Err(ApiError::Secret("db_password".into()))
        ));
        assert!(!log_write_back_failure("domain", Ok(())));
    }

    // Пароль FTP генерируется на сервере и нигде не хранится: если он не уедет
    // во фронт этим ответом, пользователь не узнает его никогда.
    #[test]
    fn provision_result_includes_ftp_credentials_when_present() {
        let r = ProvisionResultOut {
            domain_id: "1".into(),
            site_user: "u".into(),
            site_path: "/p".into(),
            ssl_issued: Some(true),
            ssl_error: None,
            db: None,
            ftp: Some(FtpOut::Created {
                ftp_user: "fu".into(),
                ftp_password: "fp".into(),
            }),
        };
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["ftp"]["ftp_user"], "fu");
        assert_eq!(v["ftp"]["ftp_password"], "fp");
    }

    // ---- «уже существовало» отдельно от «создано» и от «не делали» ----------

    // Фронт различает исходы по `status`, и без тега `created`/`exists` он
    // отличал бы их только по наличию поля пароля — то есть «пароль не пришёл»
    // читалось бы как «пароля нет», а это и есть ошибка, из которой вырос
    // весь долг №5.
    #[test]
    fn a_pre_existing_database_is_reported_as_such_and_carries_no_password() {
        let mut r = full_result();
        r.db = Some(DbOut::Exists {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            database_exists: Some(true),
        });
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["db"]["status"], "exists");
        assert_eq!(v["db"]["db_name"], "u1_db");
        // Поля пароля нет вовсе — не пустая строка, которую фронт показал бы под
        // подписью «скопируйте сейчас».
        //
        // Ассерт не вакуумный, в отличие от снятого такого же про `output`:
        // `db_password` в этот вариант можно ДОБАВИТЬ обратно (заполнив хоть
        // пустой строкой, хоть «последним известным»), и тогда он покраснеет.
        // `output` же не существует ни в одном варианте, и вернуть его — это
        // изменить тип, а не реализацию.
        assert!(v["db"].get("db_password").is_none(), "{v}");
    }

    // Пользователь есть, базы нет — база могла быть дропнута руками. Модалка
    // обязана сказать именно это, а не «база и пользователь уже существовали»:
    // провижининг базу не досоздал, и обещать её наличие — врать.
    #[test]
    fn a_dropped_database_under_a_live_user_is_reported_as_missing() {
        let mut r = full_result();
        r.db = Some(DbOut::Exists {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            database_exists: Some(false),
        });
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["db"]["status"], "exists");
        assert_eq!(v["db"]["database_exists"], false);
    }

    // Проверка не ответила, «уже существует» распознано по тексту ошибки: про
    // саму базу мы не знаем ничего. Поле опускаем целиком — `false` тут был бы
    // выдумкой, а `true` — той же выдумкой в другую сторону.
    #[test]
    fn an_unverified_database_says_nothing_about_the_database_itself() {
        let mut r = full_result();
        r.db = Some(DbOut::Exists {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            database_exists: None,
        });
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert!(v["db"].get("database_exists").is_none(), "{v}");
    }

    #[test]
    fn a_pre_existing_ftp_account_is_reported_as_such_and_carries_no_password() {
        let mut r = full_result();
        r.ftp = Some(FtpOut::Exists {
            ftp_user: "u1_ftp".into(),
        });
        let v: serde_json::Value = serde_json::to_value(&r).unwrap();
        assert_eq!(v["ftp"]["status"], "exists");
        assert_eq!(v["ftp"]["ftp_user"], "u1_ftp");
        // Про «не вакуумный» — см. соседний тест про БД.
        assert!(v["ftp"].get("ftp_password").is_none(), "{v}");
    }

    // «Создали» тоже помечено тегом: без него фронт не смог бы сузить тип и
    // добраться до пароля вообще.
    #[test]
    fn a_created_database_is_tagged_created() {
        let v: serde_json::Value = serde_json::to_value(&full_result()).unwrap();
        assert_eq!(v["db"]["status"], "created");
        assert_eq!(v["db"]["db_password"], "dbP4ssw0rd");
        assert_eq!(v["ftp"]["status"], "created");
    }

    // Существующая база — не повод не записать её имя: write-back best-effort,
    // и прошлый прогон мог до сервера не доехать. Метаданные правдивы в обоих
    // вариантах, а пароля в теле нет ни в одном.
    #[test]
    fn domain_write_back_body_records_the_names_of_a_pre_existing_database() {
        let mut r = full_result();
        r.db = Some(DbOut::Exists {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            database_exists: Some(true),
        });
        r.ftp = Some(FtpOut::Exists {
            ftp_user: "u1_ftp".into(),
        });
        let body = serde_json::to_string(&domain_write_back_body(&r, &cached("new"))).unwrap();
        assert!(body.contains("\"db_name\":\"u1_db\""), "{body}");
        assert!(body.contains("\"db_user\":\"u1_dbu\""), "{body}");
        assert!(!body.to_lowercase().contains("password"), "{body}");
    }

    // Перевод исхода создания в отчёт — единственное место, где знание о
    // существующей базе можно потерять по дороге к модалке. Сам вызывающий
    // (`run_provision_steps`) тестового харнесса не имеет: нужен `AppHandle` и
    // живой SSH, — поэтому проверяется здесь.
    #[test]
    fn db_outcome_carries_what_is_known_about_an_existing_database() {
        let (out, step) = db_outcome(DbCreation::AlreadyExists(ExistingDb {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            database_exists: Some(false),
        }));
        assert_eq!(step, "db_exists");
        match out {
            DbOut::Exists {
                database_exists, ..
            } => assert_eq!(database_exists, Some(false)),
            DbOut::Created { .. } => panic!("существующая пара выдана за созданную"),
        }
    }

    #[test]
    fn db_outcome_keeps_the_password_of_a_created_database() {
        let (out, step) = db_outcome(DbCreation::Created(CreateDbResult {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            db_password: "dbP4ssw0rd".into(),
        }));
        assert_eq!(step, "db");
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["db_password"], "dbP4ssw0rd");
    }

    #[test]
    fn ftp_outcome_distinguishes_a_kept_account_from_a_created_one() {
        let (kept, kept_step) = ftp_outcome(FtpCreation::AlreadyExists {
            ftp_user: "ftp_x".into(),
        });
        assert_eq!(kept_step, "ftp_exists");
        let v = serde_json::to_value(&kept).unwrap();
        assert_eq!(v["status"], "exists");
        // Про «не вакуумный» — см. `a_pre_existing_database_is_reported_as_such…`.
        assert!(v.get("ftp_password").is_none(), "{v}");

        let (made, made_step) = ftp_outcome(FtpCreation::Created(CreateFtpResult {
            ftp_user: "ftp_x".into(),
            ftp_password: "ftpP4ssw0rd".into(),
        }));
        assert_eq!(made_step, "ftp");
        let v = serde_json::to_value(&made).unwrap();
        assert_eq!(v["ftp_password"], "ftpP4ssw0rd");
    }

    // Базу снесли руками, пользователь остался. Записать `db_name` значило бы
    // показать в карточке домена имя базы, которой нет, — при том что модалка
    // на том же экране говорит обратное. Логин при этом правдив: он есть.
    #[test]
    fn domain_write_back_body_does_not_record_a_database_that_is_gone() {
        let mut r = full_result();
        r.db = Some(DbOut::Exists {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            database_exists: Some(false),
        });
        let body = serde_json::to_string(&domain_write_back_body(&r, &cached("new"))).unwrap();
        assert!(!body.contains("db_name"), "{body}");
        assert!(body.contains("\"db_user\":\"u1_dbu\""), "{body}");
    }

    // А неизвестность — не повод стирать: проверка молчала, и «базы нет» мы не
    // утверждаем. Имя пишем, как и раньше: прошлый прогон мог его не записать.
    #[test]
    fn domain_write_back_body_still_records_an_unverified_database() {
        let mut r = full_result();
        r.db = Some(DbOut::Exists {
            db_name: "u1_db".into(),
            db_user: "u1_dbu".into(),
            database_exists: None,
        });
        let body = serde_json::to_string(&domain_write_back_body(&r, &cached("new"))).unwrap();
        assert!(body.contains("\"db_name\":\"u1_db\""), "{body}");
    }

    // ---- массовый прогон ----------------------------------------------------

    /// Результат «как из настоящего прогона»: с FTP-аккаунтом и его паролем.
    /// Именно он на каждом не-`site_only` домене создаётся на сервере и именно
    /// он существует в единственном экземпляре.
    fn fake_result(domain_id: &str) -> ProvisionResultOut {
        ProvisionResultOut {
            domain_id: domain_id.into(),
            site_user: format!("site_{domain_id}"),
            site_path: format!("/var/www/site_{domain_id}"),
            ssl_issued: Some(true),
            ssl_error: None,
            db: None,
            ftp: Some(FtpOut::Created {
                ftp_user: format!("ftp_{domain_id}"),
                ftp_password: format!("PW-{domain_id}"),
            }),
        }
    }

    fn open_cache(dir: &std::path::Path) -> rusqlite::Connection {
        cache::open(&dir.join("cache.db"), &[9u8; 32]).unwrap()
    }

    /// Состарить строку прогона на `hours` часов — так же, как её состарило бы
    /// реальное время. Часы правим в БД, а не подменяем часы в коде: проверяем
    /// то, что прочитает настоящий `bulk_run_status`.
    fn age_run(conn: &rusqlite::Connection, key: &str, hours: i64) {
        conn.execute(
            "UPDATE bulk_runs SET created_at = datetime('now', ?2) WHERE idempotency_key = ?1",
            rusqlite::params![key, format!("-{hours} hours")],
        )
        .unwrap();
    }

    /// Пароль FTP домена из отчёта — `None`, если домен не отработал или его
    /// аккаунт уже существовал (у `FtpOut::Exists` пароля нет по устройству).
    fn ftp_password_of(out: &BulkProvisionOut, domain_id: &str) -> Option<String> {
        out.items.iter().find(|i| i.domain_id == domain_id).and_then(
            |i| match &i.outcome {
                BulkItemOutcome::Done { result } => match result.ftp.as_ref() {
                    Some(FtpOut::Created { ftp_password, .. }) => Some(ftp_password.clone()),
                    _ => None,
                },
                _ => None,
            },
        )
    }

    fn outcome_name(out: &BulkProvisionOut, domain_id: &str) -> &'static str {
        match out
            .items
            .iter()
            .find(|i| i.domain_id == domain_id)
            .map(|i| &i.outcome)
        {
            Some(BulkItemOutcome::Done { .. }) => "done",
            Some(BulkItemOutcome::Failed { .. }) => "failed",
            Some(BulkItemOutcome::Skipped) => "skipped",
            None => "missing",
        }
    }

    // Провал на пятом домене не имеет права унести пароли первых четырёх: их
    // FTP-аккаунты на сервере УЖЕ созданы, а пароли существуют только в этих
    // ответах. Раньше цикл делал `return Err(e)`, и всё созданное пропадало.
    #[tokio::test]
    async fn partial_failure_keeps_the_results_of_the_domains_that_already_ran() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_cache(dir.path());
        let ids: Vec<String> = (1..=5).map(|i| i.to_string()).collect();

        let out = run_bulk_provision(
            &mut conn,
            "k-partial",
            &ids,
            |did: String| async move {
                if did == "3" {
                    Err(CommandError::Api("ssh: connect: refused".into()))
                } else {
                    Ok(fake_result(&did))
                }
            },
            |_, _| {},
        )
        .await
        .unwrap();

        // Пароли отработавших доменов — наружу, поимённо.
        assert_eq!(ftp_password_of(&out, "1").as_deref(), Some("PW-1"));
        assert_eq!(ftp_password_of(&out, "2").as_deref(), Some("PW-2"));
        // Упавший домен назван, и назван причиной, а не пустотой.
        assert_eq!(outcome_name(&out, "3"), "failed");
        // «Не запускался» отличимо от «упал» — иначе повтор идёт вслепую.
        assert_eq!(outcome_name(&out, "4"), "skipped");
        assert_eq!(outcome_name(&out, "5"), "skipped");
        assert_eq!(out.status, BulkRunStatus::Failed);
        assert!(out.error.as_deref().unwrap().contains("domain 3"), "{:?}", out.error);

        // И прогон остался перезапускаемым: `running`/`done` заставили бы повтор
        // вернуть `already_ran`, не сделав ничего.
        let run = cache::bulk_run_status(&conn, "k-partial").unwrap().unwrap();
        assert_eq!(run.status, "failed");
        assert!(run.detail.contains("domain 3"), "{}", run.detail);
    }

    // Прогон, который уже идёт (или прошёл), обязан сказать это словами.
    // Пустой успех означал бы: пользователь видит «готово», FTP-аккаунты
    // созданы, паролей нет, и второй раз их не покажет никто.
    #[tokio::test]
    async fn a_run_that_already_happened_says_so_and_runs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_cache(dir.path());
        let ids: Vec<String> = vec!["1".into(), "2".into()];
        cache::bulk_run_upsert_start(&conn, "k-dup", "provision_bulk", "[\"1\",\"2\"]").unwrap();

        let mut ran = 0;
        let out = run_bulk_provision(
            &mut conn,
            "k-dup",
            &ids,
            |did: String| {
                ran += 1;
                async move { Ok(fake_result(&did)) }
            },
            |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(ran, 0, "второй прогон не имеет права лезть по SSH");
        assert_eq!(out.status, BulkRunStatus::AlreadyRan);
        // `running` и `done` — разные новости: у первого прогон могли оборвать,
        // и тогда «пароли уже показаны» было бы неправдой.
        assert_eq!(out.previous_status.as_deref(), Some("running"));
        assert_eq!(outcome_name(&out, "1"), "skipped");
        assert_eq!(outcome_name(&out, "2"), "skipped");
        // И ни одного «результата», который можно принять за показанный пароль.
        assert!(out.items.iter().all(|i| ftp_password_of(&out, &i.domain_id).is_none()));
    }

    #[tokio::test]
    async fn a_clean_run_returns_every_password_and_marks_the_run_done() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_cache(dir.path());
        let ids: Vec<String> = vec!["7".into(), "8".into()];

        let out = run_bulk_provision(
            &mut conn,
            "k-ok",
            &ids,
            |did: String| async move { Ok(fake_result(&did)) },
            |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(out.status, BulkRunStatus::Ok);
        assert!(out.previous_status.is_none());
        assert_eq!(ftp_password_of(&out, "7").as_deref(), Some("PW-7"));
        assert_eq!(ftp_password_of(&out, "8").as_deref(), Some("PW-8"));
        assert_eq!(
            cache::bulk_run_status(&conn, "k-ok").unwrap().unwrap().status,
            "done"
        );
    }

    // Последний шаг — запись финального статуса — тоже может упасть. Раньше он
    // отвечал `Err`, то есть сбой SQLite уносил пароли ВСЕХ отработавших
    // доменов. Домены при этом сделаны, аккаунты созданы.
    #[tokio::test]
    async fn a_failed_status_write_still_returns_the_passwords() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_cache(dir.path());
        let saboteur = open_cache(dir.path());
        let ids: Vec<String> = vec!["1".into()];

        let out = run_bulk_provision(
            &mut conn,
            "k-nostatus",
            &ids,
            |did: String| {
                // Ломаем запись статуса ровно между последним доменом и
                // финальным `bulk_run_complete`.
                saboteur.execute_batch("DROP TABLE bulk_runs").unwrap();
                async move { Ok(fake_result(&did)) }
            },
            |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(ftp_password_of(&out, "1").as_deref(), Some("PW-1"));
        assert_eq!(out.status, BulkRunStatus::Failed);
        assert!(out.error.is_some());
    }

    // Прогон, завершившийся честно, блокирует повтор всегда: этот набор
    // действительно прошёл целиком, и его пароли действительно показаны.
    #[tokio::test]
    async fn a_finished_run_keeps_blocking_no_matter_how_old_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_cache(dir.path());
        let ids: Vec<String> = vec!["1".into()];
        cache::bulk_run_upsert_start(&conn, "k-old-done", "provision_bulk", "[\"1\"]").unwrap();
        cache::bulk_run_complete(&conn, "k-old-done", "ok").unwrap();
        age_run(&conn, "k-old-done", 400);

        let mut ran = 0;
        let out = run_bulk_provision(
            &mut conn,
            "k-old-done",
            &ids,
            |did: String| {
                ran += 1;
                async move { Ok(fake_result(&did)) }
            },
            |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(ran, 0);
        assert_eq!(out.status, BulkRunStatus::AlreadyRan);
        assert_eq!(out.previous_status.as_deref(), Some("done"));
    }

    // А вот `running` снимается только явными ветками ВНУТРИ процесса: краш,
    // `Cmd+Q` или ребут посреди многочасового прогона оставляли строку навсегда,
    // и повтор того же набора упирался в `already_ran` до скончания века —
    // притом что пароли недопровиженных доменов никто никогда не видел.
    #[tokio::test]
    async fn an_orphaned_running_row_stops_blocking_after_a_day() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_cache(dir.path());
        let ids: Vec<String> = vec!["1".into()];
        cache::bulk_run_upsert_start(&conn, "k-orphan", "provision_bulk", "[\"1\"]").unwrap();
        age_run(&conn, "k-orphan", BULK_RUN_STALE_AFTER_HOURS + 1);

        let out = run_bulk_provision(
            &mut conn,
            "k-orphan",
            &ids,
            |did: String| async move { Ok(fake_result(&did)) },
            |_, _| {},
        )
        .await
        .unwrap();

        // Прогон действительно состоялся: домен отработал и его пароль пришёл.
        assert_eq!(out.status, BulkRunStatus::Ok);
        assert_eq!(ftp_password_of(&out, "1").as_deref(), Some("PW-1"));
    }

    // Порог должен быть заведомо больше самого долгого правдоподобного прогона:
    // снять `running` рано — значит пустить второй прогон поверх живого первого.
    #[tokio::test]
    async fn a_running_row_younger_than_the_threshold_still_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = open_cache(dir.path());
        let ids: Vec<String> = vec!["1".into()];
        cache::bulk_run_upsert_start(&conn, "k-fresh", "provision_bulk", "[\"1\"]").unwrap();
        age_run(&conn, "k-fresh", BULK_RUN_STALE_AFTER_HOURS - 1);

        let mut ran = 0;
        let out = run_bulk_provision(
            &mut conn,
            "k-fresh",
            &ids,
            |did: String| {
                ran += 1;
                async move { Ok(fake_result(&did)) }
            },
            |_, _| {},
        )
        .await
        .unwrap();

        assert_eq!(ran, 0, "живой прогон нельзя дублировать");
        assert_eq!(out.status, BulkRunStatus::AlreadyRan);
    }

    // Неразобранная дата = «не знаем, когда начался». Перезапустить вслепую
    // опаснее, чем оставить ключ занятым: FTP-аккаунт создаётся заново.
    #[test]
    fn an_unreadable_start_time_is_never_treated_as_stale() {
        let run = cache::BulkRun {
            status: "running".into(),
            detail: String::new(),
            created_at: "who knows".into(),
        };
        assert!(!bulk_run_is_stale(&run, chrono::Utc::now()));
    }

    // Прод-проводка команды тестового харнесса не имеет (нужен Tauri `State`),
    // поэтому подмена `site_only` на `true` не роняет ничего — а она отменяет
    // создание FTP-аккаунтов, то есть весь смысл массового прогона.
    #[test]
    fn bulk_runs_a_full_provision_and_never_a_site_only_one() {
        assert!(!BULK_SITE_ONLY, "site_only отменяет создание FTP-аккаунтов");
        assert!(!BULK_WITH_DB, "у ссылки нет параметра «создавать ли базу»");
    }

    // Отчёт уезжает во фронт как JSON — форма должна быть разбираемой:
    // у каждой строки есть `outcome`, а результат лежит там, где его ищут.
    #[test]
    fn bulk_report_serializes_with_a_readable_outcome_tag() {
        let out = BulkProvisionOut {
            idempotency_key: "k".into(),
            status: BulkRunStatus::Failed,
            error: Some("failed on domain 2: boom".into()),
            previous_status: None,
            items: vec![
                BulkProvisionItem {
                    domain_id: "1".into(),
                    outcome: BulkItemOutcome::Done {
                        result: fake_result("1"),
                    },
                },
                BulkProvisionItem {
                    domain_id: "2".into(),
                    outcome: BulkItemOutcome::Failed {
                        error: "boom".into(),
                    },
                },
                BulkProvisionItem {
                    domain_id: "3".into(),
                    outcome: BulkItemOutcome::Skipped,
                },
            ],
        };
        let v: serde_json::Value = serde_json::to_value(&out).unwrap();
        assert_eq!(v["status"], "failed");
        assert_eq!(v["items"][0]["outcome"], "done");
        assert_eq!(v["items"][0]["result"]["ftp"]["ftp_password"], "PW-1");
        assert_eq!(v["items"][1]["outcome"], "failed");
        assert_eq!(v["items"][1]["error"], "boom");
        assert_eq!(v["items"][2]["outcome"], "skipped");
    }

    // ---- видимость упавшего провижининга (фаза 4, долг №4) -----------------
    //
    // До этой фазы `?` уносил управление ДО блока write-back, и упавший прогон
    // не записывал ничего: «Last error» в UI был вечным «—». Здесь проверяется
    // ЭФФЕКТ — что именно уходит на сервер по каждому виду провала.

    /// Пароль, которым «испачканы» входные ошибки всех тестов ниже: если он
    /// хоть где-то доедет до серверного текста, это видно сразу.
    const LEAKED: &str = "hunter2-P4ssw0rd";

    // Единственный источник, у которого сырой вывод команды доезжает до текста
    // ошибки (`create_site` его туда кладёт целиком). На сервер уходит шаг и
    // класс — вывода нет; в UI десктопа возвращается полный текст.
    #[test]
    fn a_failed_step_sends_the_server_a_step_and_a_class_but_no_command_output() {
        let f = ProvisionFailure::at(
            STEP_CREATE_SITE,
            SshError::Session(format!(
                "create_site exit 1: fastpanel sites create --password={LEAKED} failed"
            )),
        );

        assert_eq!(
            f.server_text(),
            "provision failed at create_site: the command failed on the server"
        );
        // Полный текст остаётся на этой машине — иначе чинить нечем.
        assert!(f.error.to_string().contains(LEAKED), "{}", f.error);
    }

    // Каждый источник ошибки провижининга по отдельности: ни один не выпускает
    // на сервер ни байта из текста ошибки, и каждый называет свой класс. Общий
    // `assert` на отсутствие пароля тут был бы верен при любой реализации
    // (`&'static str` иначе и не собрать), поэтому проверяется РАВЕНСТВО
    // ожидаемому тексту — оно ловит и подмену класса, и приписку к нему.
    #[test]
    fn every_error_source_of_the_provision_path_is_classified() {
        let dirty = |m: &str| format!("{m} {LEAKED}");
        let cases: Vec<(ProvisionFailure, &str)> = vec![
            (
                ProvisionFailure::from(CommandError::Keychain(dirty("locked"))),
                "provision failed at prepare: the vault is locked or unavailable on the desktop",
            ),
            (
                ProvisionFailure::from(CommandError::Aead(dirty("decrypt"))),
                "provision failed at prepare: the stored ssh password could not be decrypted",
            ),
            // Локальный кэш и ответы сервера — слишком разное, чтобы честно
            // назвать одним классом. Тогда пользователю достаётся один шаг.
            (
                ProvisionFailure::from(CommandError::Api(dirty("domain not in local cache"))),
                "provision failed at prepare",
            ),
            (
                ProvisionFailure::at(STEP_SSH_CONNECT, auth_err()),
                "provision failed at ssh_connect: ssh authentication failed",
            ),
            (
                ProvisionFailure::at(STEP_SSH_CONNECT, SshError::Connect(dirty("refused"))),
                "provision failed at ssh_connect: could not open an ssh connection",
            ),
            (
                ProvisionFailure::at(STEP_SSH_CONNECT, SshError::HostKeyMismatch),
                "provision failed at ssh_connect: the ssh host key was not accepted",
            ),
            (
                ProvisionFailure::known(
                    STEP_FASTPANEL_PATH,
                    CAUSE_NO_FASTPANEL,
                    CommandError::Api("fastpanel binary not found on server".into()),
                ),
                "provision failed at fastpanel_path: fastpanel is not installed on the server",
            ),
            (
                ProvisionFailure::at(STEP_FIREWALL, SshError::Session("exec timeout".into())),
                "provision failed at firewall_preflight: the command timed out on the server",
            ),
            (
                // `create_ftp_account` отдаёт `opaque_exit` — вывод уже снят,
                // но класс шага всё равно обязан назваться.
                ProvisionFailure::at(
                    STEP_FTP,
                    SshError::Session(dirty("create_ftp_account exit 1")),
                ),
                "provision failed at ftp: the command failed on the server",
            ),
            (
                ProvisionFailure::db(SshError::Session(dirty("CREATE USER IDENTIFIED BY"))),
                "provision failed at db: the command failed on the server",
            ),
            (
                ProvisionFailure::db(SshError::Session("exec timeout".into())),
                "provision failed at db: the command timed out on the server",
            ),
        ];

        for (f, expected) in cases {
            assert_eq!(f.server_text(), expected);
            let body = serde_json::to_string(&domain_failure_write_back_body(&f)).unwrap();
            assert!(!body.contains(LEAKED), "{body}");
        }
    }

    // Провал БД отдаёт наружу обезличенный `db_error` (в UI десктопа), а
    // серверу — свой класс. Пароль БД не доезжает ни туда, ни туда.
    #[test]
    fn a_failed_database_step_hides_the_output_from_the_desktop_too() {
        let f = ProvisionFailure::db(SshError::Session(format!(
            "mysql: CREATE USER 'u'@'localhost' IDENTIFIED BY '{LEAKED}'"
        )));
        assert!(!f.error.to_string().contains(LEAKED), "{}", f.error);
        assert!(!f.server_text().contains(LEAKED));
    }

    // Тело провала — ровно два поля. Остальное сервер применяет через
    // `exclude_unset`, и лишний ключ стёр бы правду удачного прогона до него
    // (`site_user`, `db_name`, `ssl_status`).
    #[test]
    fn domain_failure_write_back_body_touches_only_the_status_and_the_error() {
        let f = ProvisionFailure::at(STEP_SSH_CONNECT, auth_err());
        assert_eq!(
            serde_json::to_string(&domain_failure_write_back_body(&f)).unwrap(),
            "{\"status\":\"failed\",\"last_provision_error\":\
             \"provision failed at ssh_connect: ssh authentication failed\"}"
        );
    }

    // Без этого домен, помеченный `failed`, оставался бы красным навсегда:
    // ошибку удачный прогон гасит, а статус — нет.
    //
    // Четвёртый случай — обратная половина третьего, и без него зелёными
    // остались бы обе мутации сразу: «при `None` всегда `site_created`» (тогда
    // site-only повтор понижал бы живой `active`) и «при `None` не трогать
    // никогда» (тогда `failed` не гасился бы). Пары «гасим»/«не трогаем»
    // различают их поимённо.
    #[test]
    fn a_finished_run_takes_the_domain_out_of_failed() {
        let b = domain_write_back_body(&full_result(), &cached("new"));
        assert_eq!(b.status.as_deref(), Some("active"));
        assert_eq!(b.last_provision_error, Some(None));

        // SSL не вышел — сайт всё равно создан, и это не `failed`.
        let mut r = full_result();
        r.ssl_issued = Some(false);
        assert_eq!(
            domain_write_back_body(&r, &cached("new")).status.as_deref(),
            Some("site_created")
        );

        // SSL не пробовали (`site_only`), а домен помечен упавшим: гасим —
        // ошибку этот прогон стирает, и красный бейдж при пустой ошибке лгал бы.
        let mut r = full_result();
        r.ssl_issued = None;
        assert_eq!(
            domain_write_back_body(&r, &cached("failed"))
                .status
                .as_deref(),
            Some("site_created")
        );

        // Тот же site-only прогон по живому домену статус НЕ трогает: знания
        // про SSL у него нет, а `site_created` понизил бы настоящий `active`.
        // Ключ `"status"` целиком, а не подстрока: `ssl_status` содержит её и
        // спрятал бы разницу, окажись он в теле.
        let body = serde_json::to_string(&domain_write_back_body(&r, &cached("active"))).unwrap();
        assert!(!body.contains("\"status\""), "{body}");
    }

    // ЭФФЕКТ ради которого фаза: упавший прогон реально уходит на сервер — в
    // тот домен, на котором упал, и ровно двумя полями. Проверяется по запросу,
    // ушедшему в сеть, а не по факту вызова функции.
    #[tokio::test]
    async fn a_failed_run_writes_the_error_to_that_domain() {
        use wiremock::matchers::{body_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/domains/42"))
            .and(body_json(serde_json::json!({
                "status": "failed",
                "last_provision_error":
                    "provision failed at create_site: the command failed on the server",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": 42})))
            // Без `.expect(1)` расхождение в теле выглядело бы как 404 от
            // незамэтченного запроса — ни диффа, ни намёка, что дело в теле.
            // Оно же ловит запись не в тот домен: путь входит в матч.
            .expect(1)
            .named("PUT /domains/42 со статусом failed и текстом ошибки")
            .mount(&srv)
            .await;

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        let f = ProvisionFailure::at(
            STEP_CREATE_SITE,
            SshError::Session(format!("create_site exit 1: --password={LEAKED}")),
        );

        assert!(
            !record_provision_failure(&api, "42", &f).await,
            "запись прошла, а функция сказала, что нет"
        );
    }

    // Сеть могла отвалиться вместе с самим провижинингом. Тогда провал записи —
    // это флаг наружу, а не подмена причины: `?` здесь превратил бы «ssh: auth
    // failed» в «write-back failed», то есть потерял бы ту самую ошибку, ради
    // которой всё.
    //
    // Через `finish_provision`, а не напрямую через `record_provision_failure`:
    // флаг должен ДОЕХАТЬ до вызывающего (там он поднимает событие
    // `writeback_failed`), и на прямом вызове мутация «вернуть `false` всегда»
    // осталась бы зелёной — успешная запись тоже даёт `false`.
    #[tokio::test]
    async fn a_failed_write_back_of_the_failure_is_a_flag_not_a_new_error() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/domains/42"))
            .respond_with(ResponseTemplate::new(500).set_body_json(serde_json::json!({})))
            .mount(&srv)
            .await;

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        let outcome = Err(ProvisionFailure::at(STEP_SSH_CONNECT, auth_err()));

        let (result, write_back_failed) = finish_provision(&api, "42", outcome).await;

        assert!(write_back_failed, "провал записи не доехал до вызывающего");
        // И причина осталась прежней: «write-back failed» её не заменил.
        match result {
            Err(e) => assert!(e.to_string().starts_with("ssh: auth failed"), "{e}"),
            Ok(_) => panic!("провал прочитался как успех"),
        }
    }

    // Та самая связка, ради которой фаза: ошибка из `provision_domain_inner`
    // обязана превратиться в запись на сервере. Ревьюер заменил вызов на
    // `if false && record_provision_failure(...)` — и все 176 тестов остались
    // зелёными, потому что связка жила строчкой в функции, которую не поднять
    // без Tauri-харнесса. Теперь она в `finish_provision`, и тест смотрит на
    // ушедший запрос.
    #[tokio::test]
    async fn a_failed_outcome_turns_into_a_write_back_and_keeps_the_original_error() {
        use wiremock::matchers::{body_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let srv = MockServer::start().await;
        Mock::given(method("PUT"))
            .and(path("/api/domains/42"))
            .and(body_json(serde_json::json!({
                "status": "failed",
                "last_provision_error":
                    "provision failed at create_site: the command failed on the server",
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": 42})))
            .expect(1)
            .named("провал прогона доезжает до PUT /domains/42")
            .mount(&srv)
            .await;

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        let outcome = Err(ProvisionFailure::at(
            STEP_CREATE_SITE,
            SshError::Session(format!("create_site exit 1: --password={LEAKED}")),
        ));

        let (result, write_back_failed) = finish_provision(&api, "42", outcome).await;

        assert!(!write_back_failed);
        // Наружу — исходная ошибка целиком: она нужна пользователю, чтобы
        // чинить, и подменять её обезличенным серверным текстом нельзя.
        match result {
            Err(e) => assert!(e.to_string().contains(LEAKED), "{e}"),
            Ok(_) => panic!("провал прочитался как успех"),
        }
    }

    // Обратная половина: удачный прогон НИЧЕГО не пишет через этот путь (его
    // write-back — свой, внутри `provision_domain_inner`). Без этого мутация
    // «писать провал всегда» осталась бы зелёной.
    #[tokio::test]
    async fn a_finished_outcome_writes_no_failure_at_all() {
        use wiremock::matchers::any;
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let srv = MockServer::start().await;
        Mock::given(any())
            .respond_with(ResponseTemplate::new(200))
            .expect(0)
            .named("удачный прогон не шлёт запись провала")
            .mount(&srv)
            .await;

        let api = ApiClient::new(format!("{}/api", srv.uri()));
        let (result, write_back_failed) = finish_provision(&api, "42", Ok(full_result())).await;

        assert!(!write_back_failed);
        assert!(result.is_ok());
    }
}
