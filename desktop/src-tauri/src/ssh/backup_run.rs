//! Создание архива домена на сервере: `tar` каталога сайта + `mysqldump` баз +
//! манифест, всё это одним `.tar` в рабочем каталоге на СЕРВЕРЕ.
//!
//! Отдельный файл, а не рост `fastpanel.rs`: тот про создание сущностей панели
//! (сайт, БД, FTP), а здесь — своя ответственность и своя цена ошибки. Зеркалит
//! существующее разделение `fastpanel.rs` (создаёт) / `fastpanel_facts.rs`
//! (читает).
//!
//! **Модуль заканчивается на «архив лежит на сервере, вот путь, размер и
//! sha256».** Он ничего не скачивает и о локальной ФС не знает вовсе — это
//! сделано ради места, оставленного внешним хранилищам (S3/FTP): выгрузка любому
//! адресату — отдельный шаг ПОСЛЕ `checksum`, и второй адресат добавляется
//! рядом со скачиванием, а не вместо него. Ни этот модуль, ни зовущая его
//! команда при этом не переписываются.
//!
//! Ни секретов, ни сырого вывода команд в [`BackupArtifact`] не попадает — та же
//! дисциплина, что у `CreateSiteResult` в `fastpanel.rs` и `DomainFacts` в
//! `fastpanel_facts.rs`.
//!
//! Про шелл: `set -o pipefail` и `${PIPESTATUS[*]}` — это bash/ksh, а не голый
//! POSIX sh. У серверов FastPanel логин-шелл root'а — bash (там же живёт сама
//! панель), и план сознательно опирается на это. Страховка от обратного — не
//! «догадаться по коду возврата», а отказ: если строка-маркер `SDMP_RC` не
//! доехала, исход конвейера считается непонятым, и мы отказываем, а не считаем
//! молчание успехом.

use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;

use crate::ssh::client::SshError;
use crate::ssh::fastpanel::{json_slice, normalize_site_row, q, Exec};
use crate::ssh::fastpanel_facts::find_site_row;

/// Рабочий каталог — под `/var/tmp`, а НЕ под каталогом сайта.
///
/// Это дыра, а не стилистика: всё, что лежит под document root, отдаётся веб-сервером
/// по HTTP кому угодно, пока оно там лежит, — то есть архив с дампами баз можно было
/// бы просто скачать по прямой ссылке. Вдобавок такой архив попадает внутрь
/// СЛЕДУЮЩЕГО `tar` самого себя, и каждая копия удваивается.
///
/// Именно `/var/tmp`, а не `/tmp`: systemd чистит `/tmp` агрессивно (и на многих
/// сборках это tmpfs, то есть ОЗУ), а гигабайтный архив живёт минутами и обязан
/// пережить их на диске.
pub const BACKUP_WORK_ROOT: &str = "/var/tmp/sdmp-backup";

/// Предел на короткий шаг (резолв, инвентарь инструментов, место, замок,
/// контрольная сумма, уборка). Ровно как в плане.
pub const BACKUP_STEP_TIMEOUT: Duration = Duration::from_secs(60);

/// Предел на шаг, который реально работает с гигабайтами: `tar`, `mysqldump`,
/// упаковка. Час — это «сайт на 100 ГБ при 30 МБ/с», а не запас на всякий случай.
pub const BACKUP_ARCHIVE_TIMEOUT: Duration = Duration::from_secs(3600);

/// Во сколько раз (в процентах) свободного места должно быть больше оценки.
/// Оценка — размер каталога сайта до сжатия; 1.2× закрывает дампы баз и
/// промежуточную копию при упаковке.
pub const BACKUP_SPACE_FACTOR_PERCENT: u64 = 120;

/// Старше этого возраста замок выглядит брошенным. **Это только формулировка
/// ошибки, а не право снести:** см. [`acquire_lock`].
pub const BACKUP_LOCK_STALE_AFTER: Duration = Duration::from_secs(6 * 3600);

/// Версия формата манифеста. Меняется только вместе с формой файла.
pub const BACKUP_MANIFEST_FORMAT: &str = "sdmp-backup/1";

/// Чем сделан архив — попадает в манифест, чтобы через полгода было понятно, что
/// это за файл и какой сборкой он собран.
pub const BACKUP_TOOL: &str = concat!("sdmp-desktop/", env!("CARGO_PKG_VERSION"));

/// Имя части с файлами сайта внутри архива.
pub const SITE_PART: &str = "site.tar.gz";
/// Имя манифеста внутри архива.
pub const MANIFEST_PART: &str = "manifest.json";

/// Обязательные инструменты. `mysqldump` в список не входит: он нужен, только
/// если у домена есть базы, и требовать его от сервера со статикой незачем.
const REQUIRED_TOOLS: [&str; 5] = ["tar", "gzip", "sha256sum", "du", "df"];
/// Необязательные: без них бэкап делается, но грубее для живого сайта.
const OPTIONAL_TOOLS: [&str; 2] = ["nice", "ionice"];

/// Код, которым `exec` обозначает «итог команды не доехал».
///
/// Все шаги здесь идут через обычный `exec` (короткий текстовый вывод), а не
/// через `exec_to_writer` — качать архив будет фаза 4. Разница важна: в потоковом
/// цикле убитая команда приезжает честно, `signal: Some("KILL")`, а `exec`
/// ветки `ChannelMsg::ExitSignal` не разбирает вовсе, и та же смерть выглядит
/// здесь просто отсутствием `exit-status`, то есть `-1`. Гигабайтный `tar` на
/// продакшне — первый кандидат на OOM-killer, поэтому такой конец обязан быть
/// отказом, а не тишиной.
///
/// Там, где мы сверяем `code != 0`, `-1` попадает в отказ сам собой. Там, где
/// код шага нам неинтересен (`du` возвращает ненулевой на любом нечитаемом
/// подкаталоге, но размер печатает), `-1` проверяется отдельно — иначе убитая
/// команда прошла бы как «просто вывод не разобрался». А у конвейеров смерть
/// звена видна ещё и в `PIPESTATUS`: сигнал там выглядит как 128+N (`kill -9` →
/// 137), и любой такой код — отказ по общему правилу «≥ 2».
const NO_EXIT_STATUS: i32 = -1;

/// Убедиться, что итог шага вообще доехал. См. [`NO_EXIT_STATUS`].
fn ensure_exit_status_arrived(step: &'static str, code: i32) -> Result<(), BackupError> {
    if code == NO_EXIT_STATUS {
        return Err(BackupError::Unreadable {
            step,
            detail: "the command ended without reporting an exit status — it was most likely \
                     killed (OOM) or the channel died"
                .to_string(),
        });
    }
    Ok(())
}

const RC_MARKER: &str = "SDMP_RC";
const DU_MARKER: &str = "SDMP_DU";
const DF_MARKER: &str = "SDMP_DF";
const LOCK_MARKER: &str = "SDMP_LOCK";

/// Шесть элементов ниже (`PIPE_STATUS_TAIL`, `parse_pipeline_status`, замок и
/// уборка) объявлены `pub`, а не `pub(crate)`, РАДИ ДОКАЗАТЕЛЬСТВА: они
/// проверяются интеграционными тестами в `tests/ssh_integration.rs`, а это
/// отдельный крейт, и `pub(crate)` ему не виден. Юнит-тест их формы проверить
/// может, а вот «`mkdir` второй раз действительно падает» и «`PIPESTATUS`
/// доезжает через настоящий exec-канал» — только живой сервер.

/// Хвост, который печатает коды ВСЕХ звеньев конвейера.
///
/// Одного `set -o pipefail` мало, и это не педантизм: pipefail отдаёт код
/// последнего упавшего звена, поэтому «`tar` вернул 1 (файлы менялись), `gzip`
/// отработал» и «`tar` отработал, `gzip` упал (диск кончился)» приходят одним и
/// тем же кодом 1 — а первое у нас предупреждение, второе отказ с обрезанным
/// архивом. `PIPESTATUS` разводит эти два случая.
///
/// Присваивание идёт СРАЗУ после конвейера: любая другая команда (включая
/// `rc=$?`) обнуляет `PIPESTATUS`.
pub const PIPE_STATUS_TAIL: &str = "st=\"${PIPESTATUS[*]}\"; printf 'SDMP_RC\\t%s\\n' \"$st\"";

/// Отказ создания бэкапа. Отдельный тип, а не `SshError::Session(String)`:
/// половина исходов здесь действенная («замок занят», «нет места», «не знаем
/// баз»), и вызывающему из фазы 4 нужно уметь их различать не по подстроке.
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error(transparent)]
    Ssh(#[from] SshError),

    #[error("site {domain} is not in `sites list --json` on this server — nothing to archive")]
    SiteNotFound { domain: String },

    /// Путь сайта прочитан, но выглядит опасно (не абсолютный, слишком короткий).
    #[error("refusing to archive {path}: it does not look like a site directory")]
    UnsafeSitePath { path: String },

    /// Мы не смогли УЗНАТЬ список баз — и это не то же самое, что «баз нет».
    #[error(
        "cannot tell which databases belong to {domain}: {reason}. \
         Refusing to build an archive that would look complete without them"
    )]
    DatabasesUnknown { domain: String, reason: String },

    #[error(
        "database name {name:?} has characters SDMP will not put into a file name inside the archive"
    )]
    UnsafeDatabaseName { name: String },

    #[error("the server is missing tools this backup needs: {tools}")]
    MissingTools { tools: String },

    #[error(
        "not enough free space under {root}: the site is {est_kb} KiB, \
         we need at least {need_kb} KiB, {avail_kb} KiB are free"
    )]
    NotEnoughSpace {
        root: String,
        est_kb: u64,
        need_kb: u64,
        avail_kb: u64,
    },

    /// Замок занят. Текст обязан быть действенным: путь + прямое указание, что
    /// снимать его SDMP не будет.
    #[error(
        "a backup lock is held at {path}: {state}. SDMP never removes this lock by itself — \
         a lock that looks stale may be another desktop's backup still running. \
         If you are sure nothing is running, remove it by hand: rm -rf {path}"
    )]
    LockHeld { path: String, state: String },

    #[error("step {step} failed: {detail}")]
    Step { step: &'static str, detail: String },

    /// Команда отработала, но её вывод мы не поняли — а гадать тут нельзя.
    #[error("step {step} produced output we cannot read: {detail}")]
    Unreadable { step: &'static str, detail: String },
}

/// Часть внутри архива.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct BackupPart {
    pub name: String,
    /// `files` | `database`.
    pub kind: String,
    pub sha256: String,
}

/// Готовый архив НА СЕРВЕРЕ. Ни байта содержимого, ни сырого вывода команд.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct BackupArtifact {
    /// Полный путь на сервере.
    pub path: String,
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
    pub parts: Vec<BackupPart>,
    pub databases: Vec<String>,
    pub site_path: String,
    pub created_at: DateTime<Utc>,
    /// Что прошло, но не идеально (файлы менялись при чтении, не нашлось
    /// `ionice`, не убрался рабочий каталог). Пустой список — чисто.
    pub warnings: Vec<String>,
}

/// Что и откуда архивируем.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackupTarget {
    pub site_path: String,
    pub databases: Vec<String>,
}

/// Инструменты, которые есть на сервере (только необязательные — обязательных
/// без отказа не бывает).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BackupTools {
    pub nice: bool,
    pub ionice: bool,
}

/// Пути прогона. Замок и рабочий каталог — ОДНО И ТО ЖЕ: снятие замка и уборка
/// мусора обязаны быть одним действием, иначе рано или поздно останется одно без
/// другого. Архив лежит РЯДОМ, а не внутри, — уборка не должна его уносить.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackupPaths {
    pub root: String,
    /// Он же замок.
    pub work: String,
    pub archive: String,
    pub file_name: String,
}

impl BackupPaths {
    pub(crate) fn new(domain: &str, now: DateTime<Utc>) -> Self {
        let slug = safe_component(domain);
        let file_name = format!("{slug}-{}.tar", now.format("%Y%m%dT%H%M%SZ"));
        BackupPaths {
            root: BACKUP_WORK_ROOT.to_string(),
            work: format!("{BACKUP_WORK_ROOT}/{slug}"),
            archive: format!("{BACKUP_WORK_ROOT}/{file_name}"),
            file_name,
        }
    }
}

/// Домен → одна безопасная составляющая пути.
///
/// Домен приезжает из нашей же БД, но подставляется в путь на чужой машине, и
/// `..` или `/` в нём увели бы `mkdir`/`rm -rf` куда угодно. `q()` спасает от
/// шелла, но не от смысла пути — поэтому чистим отдельно. Ведущая точка
/// заменяется всегда: это разом убивает и `.`, и `..` как имя каталога.
pub(crate) fn safe_component(domain: &str) -> String {
    let mut out: String = domain
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect();
    if out.starts_with('.') {
        out.replace_range(0..1, "_");
    }
    if out.is_empty() {
        out.push('_');
    }
    out
}

// ---- resolve ---------------------------------------------------------------

/// Путь каталога сайта из строки `sites list --json`.
///
/// `index_dir` — первый источник (именно его отдаёт эта сборка панели),
/// `normalize_site_row` — второй: он умеет `site_path`/`path`/`www_path` и
/// сборку из `owner.home_dir`.
pub(crate) fn site_path_from_row(row: &serde_json::Value) -> Option<String> {
    let from_index = row
        .get("index_dir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    from_index.or_else(|| normalize_site_row(row).and_then(|s| s.site_path))
}

/// Путь годится под `tar -C <родитель> <база>`?
///
/// Проверка не от злого умысла, а от чужой формы JSON: `/` или `/var/www` в
/// `index_dir` означали бы «заархивируй пол-сервера», и это лучше заметить до
/// того, как `tar` начнёт работать. Отсюда «минимум три слэша» — путь сайта у
/// FastPanel всегда `/var/www/<owner>/data/www/<domain>`.
pub(crate) fn site_path_is_sane(path: &str) -> bool {
    path.starts_with('/')
        && !path.ends_with('/')
        && !path.contains('\n')
        && !path.contains("/..")
        && path.matches('/').count() >= 3
}

/// Базы домена из `databases list --json` — строже, чем при чтении фактов.
///
/// `Some(vec![])` здесь значит РОВНО «панель ответила понятной формой, и баз у
/// этого домена нет», а `None` — «мы не поняли ответ». Разница принципиальна
/// именно для бэкапа: `list_site_databases` из `fastpanel_facts` схлопывает
/// «баз нет» и «обе команды упали» в один пустой список, и для карточки домена
/// это уже признавали проблемой, а здесь пустой список молча дал бы архив без
/// единой базы, который выглядит полным и обнаруживается только при попытке
/// восстановиться. Поэтому:
///
/// - разбираем сами, а не зовём `list_site_databases`;
/// - правило `ftp_accounts_from_json` переносится дословно: массив непуст, а ни
///   одной УЗНАВАЕМОЙ строки (со `site.domain`) в нём нет → форма чужая → `None`;
/// - строка нашего домена без `name` → `None`: молча потерять одну базу из трёх
///   хуже, чем отказать;
/// - mysql-фолбэка нет вовсе. В `fastpanel_facts` он фильтрует по префиксу
///   имени, а на этой сборке имена БД захешированы (`skonloedb`) и с доменом не
///   совпадают — то есть фолбэк почти наверняка вернул бы пусто, и это было бы
///   «не знаем», выданное за «нет».
pub(crate) fn databases_for_backup(raw: &str, domain: &str) -> Option<Vec<String>> {
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
    if arr.is_empty() {
        // Панель ответила «на сервере баз нет вовсе» — это ответ.
        return Some(Vec::new());
    }
    let want = domain.trim().to_lowercase();
    let mut recognized = 0usize;
    let mut names = Vec::new();
    for item in arr {
        let site_domain = item
            .get("site")
            .and_then(|s| s.get("domain"))
            .and_then(|d| d.as_str())
            .map(|d| d.trim().to_lowercase())
            .filter(|d| !d.is_empty());
        let Some(site_domain) = site_domain else {
            continue;
        };
        recognized += 1;
        // Сравнение целиком, а не по префиксу: `example.com.old` — другой домен.
        if site_domain != want {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::trim)
            .filter(|n| !n.is_empty())?;
        names.push(name.to_string());
    }
    if recognized == 0 {
        return None;
    }
    Some(names)
}

/// Имя базы, которое не стыдно положить в имя файла внутри архива.
pub(crate) fn db_name_is_safe(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '$')
}

/// Имя части-дампа внутри архива.
pub(crate) fn db_part_name(db: &str) -> String {
    format!("db-{db}.sql.gz")
}

pub(crate) async fn resolve_target(
    s: &mut impl Exec,
    fp_path: &str,
    domain: &str,
) -> Result<BackupTarget, BackupError> {
    let (code, out) = s
        .run(
            &format!("{} sites list --json", q(fp_path)),
            BACKUP_STEP_TIMEOUT,
        )
        .await?;
    if code != 0 {
        return Err(BackupError::Step {
            step: "resolve",
            detail: format!("`sites list --json` exited {code}"),
        });
    }
    // Текстового фолбэка (как в `list_sites`) здесь нет намеренно: угадать путь
    // каталога сайта из таблицы и потом заархивировать УГАДАННОЕ хуже, чем
    // отказать.
    let row = find_site_row(&out, domain).ok_or_else(|| BackupError::SiteNotFound {
        domain: domain.to_string(),
    })?;
    let site_path = site_path_from_row(&row).ok_or_else(|| BackupError::Step {
        step: "resolve",
        detail: format!("no site directory in the panel row for {domain}"),
    })?;
    if !site_path_is_sane(&site_path) {
        return Err(BackupError::UnsafeSitePath { path: site_path });
    }

    // Мн.ч. `databases` — НЕ `database`: ед.ч. на этой сборке падает
    // (`expected command but got "database"`, сверено).
    let (c2, o2) = s
        .run(
            &format!("{} databases list --json", q(fp_path)),
            BACKUP_STEP_TIMEOUT,
        )
        .await?;
    if c2 != 0 {
        return Err(BackupError::DatabasesUnknown {
            domain: domain.to_string(),
            reason: format!("`databases list --json` exited {c2}"),
        });
    }
    let databases =
        databases_for_backup(&o2, domain).ok_or_else(|| BackupError::DatabasesUnknown {
            domain: domain.to_string(),
            reason: "the output of `databases list --json` did not have a shape we recognise"
                .to_string(),
        })?;
    for db in &databases {
        if !db_name_is_safe(db) {
            return Err(BackupError::UnsafeDatabaseName { name: db.clone() });
        }
    }
    Ok(BackupTarget {
        site_path,
        databases,
    })
}

// ---- preflight -------------------------------------------------------------

/// Проверка наличия инструментов циклом, а не одним `command -v tar gzip …`.
///
/// Так надо: у bash `command -v` с несколькими именами печатает найденные и
/// возвращает 0, даже если часть имён не нашлась, — то есть плановая
/// однострочная форма не умеет ответить на вопрос «чего нет». Цикл печатает
/// `имя<TAB>OK|MISSING` по образцу `build_log_stat_cmd` из `fastpanel_facts`.
pub(crate) fn build_tools_probe_cmd(tools: &[&str]) -> String {
    let list: Vec<String> = tools.iter().map(|t| q(t)).collect();
    format!(
        "for t in {}; do if command -v \"$t\" >/dev/null 2>&1; \
         then printf '%s\\tOK\\n' \"$t\"; else printf '%s\\tMISSING\\n' \"$t\"; fi; done",
        list.join(" ")
    )
}

/// Имена инструментов, которых на сервере нет (из вывода [`build_tools_probe_cmd`]).
pub(crate) fn parse_missing_tools(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|l| l.trim().split_once('\t'))
        .filter(|(_, state)| state.trim() == "MISSING")
        .map(|(name, _)| name.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

pub(crate) async fn probe_tools(
    s: &mut impl Exec,
    needs_mysqldump: bool,
) -> Result<BackupTools, BackupError> {
    let mut wanted: Vec<&str> = REQUIRED_TOOLS.to_vec();
    if needs_mysqldump {
        wanted.push("mysqldump");
    }
    wanted.extend_from_slice(&OPTIONAL_TOOLS);
    let cmd = build_tools_probe_cmd(&wanted);
    let (code, out) = s.run(&cmd, BACKUP_STEP_TIMEOUT).await?;
    // Код возврата не смотрим (цикл завершается успешно и когда всё отсутствует)
    // — кроме «итог не доехал»: см. `NO_EXIT_STATUS`.
    ensure_exit_status_arrived("preflight", code)?;
    // Пустой вывод — это «мы не поняли», а не «всё на месте».
    if out.trim().is_empty() {
        return Err(BackupError::Unreadable {
            step: "preflight",
            detail: "the tool probe printed nothing".to_string(),
        });
    }
    let missing = parse_missing_tools(&out);
    let blocking: Vec<String> = missing
        .iter()
        .filter(|m| !OPTIONAL_TOOLS.contains(&m.as_str()))
        .cloned()
        .collect();
    if !blocking.is_empty() {
        return Err(BackupError::MissingTools {
            tools: blocking.join(", "),
        });
    }
    Ok(BackupTools {
        nice: !missing.iter().any(|m| m == "nice"),
        ionice: !missing.iter().any(|m| m == "ionice"),
    })
}

// ---- space -----------------------------------------------------------------

/// Размер каталога сайта и свободное место одной командой.
///
/// `df` спрашивается про РОДИТЕЛЯ рабочего каталога (`/var/tmp`): сам
/// `/var/tmp/sdmp-backup` до первого прогона не существует, а `df` на
/// несуществующем пути падает.
pub(crate) fn build_space_cmd(site_path: &str, work_root: &str) -> String {
    let df_target = Path::new(work_root)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or("/var/tmp");
    format!(
        "printf '{DU_MARKER}\\n'; du -sk {} 2>/dev/null; printf '{DF_MARKER}\\n'; df -Pk {}",
        q(site_path),
        q(df_target)
    )
}

/// Килобайты из секции `du`. Строки-жалобы `du: cannot read …` не начинаются с
/// числа и отсеиваются сами.
pub(crate) fn parse_du_kb(output: &str) -> Option<u64> {
    section(output, DU_MARKER, DF_MARKER)
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .find_map(|tok| tok.parse::<u64>().ok())
}

/// Свободные килобайты из секции `df -Pk`: колонка `Available` (четвёртая).
/// Заголовок отсеивается тем, что в нём числа не парсятся.
pub(crate) fn parse_df_avail_kb(output: &str) -> Option<u64> {
    for line in section(output, DF_MARKER, "\u{0}").lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let n = f.len();
        // Имя устройства может содержать пробелы, поэтому считаем с конца:
        // …, 1024-blocks, Used, Available, Capacity, Mounted on.
        if let (Ok(_), Ok(_), Ok(avail)) = (
            f[n - 5].parse::<u64>(),
            f[n - 4].parse::<u64>(),
            f[n - 3].parse::<u64>(),
        ) {
            return Some(avail);
        }
    }
    None
}

fn section<'a>(output: &'a str, from: &str, to: &str) -> &'a str {
    let start = match output.find(from) {
        Some(i) => i + from.len(),
        None => return "",
    };
    let rest = &output[start..];
    match rest.find(to) {
        Some(i) => &rest[..i],
        None => rest,
    }
}

/// Хватает ли места. Целочисленно и без `f64`: на границе (ровно 1.2×) ответ
/// обязан быть «да», а с плавающей точкой это лотерея.
pub(crate) fn has_enough_space(est_kb: u64, avail_kb: u64) -> bool {
    avail_kb.saturating_mul(100) >= est_kb.saturating_mul(BACKUP_SPACE_FACTOR_PERCENT)
}

/// Сколько нужно свободного места под оценку.
pub(crate) fn needed_kb(est_kb: u64) -> u64 {
    // Округление вверх: «нужно 1200.5 КиБ» значит «1201», а не «1200».
    est_kb
        .saturating_mul(BACKUP_SPACE_FACTOR_PERCENT)
        .saturating_add(99)
        / 100
}

pub(crate) async fn check_space(
    s: &mut impl Exec,
    site_path: &str,
    root: &str,
) -> Result<u64, BackupError> {
    let (code, out) = s
        .run(&build_space_cmd(site_path, root), BACKUP_STEP_TIMEOUT)
        .await?;
    // Код возврата не смотрим: `du` возвращает не ноль на любом нечитаемом
    // подкаталоге, а размер при этом печатает. Читаем вывод. Исключение одно —
    // «итога не было вовсе» (`NO_EXIT_STATUS`).
    ensure_exit_status_arrived("space", code)?;
    let est_kb = parse_du_kb(&out).ok_or_else(|| BackupError::Unreadable {
        step: "space",
        detail: format!("`du -sk {site_path}` did not print a size"),
    })?;
    let avail_kb = parse_df_avail_kb(&out).ok_or_else(|| BackupError::Unreadable {
        step: "space",
        detail: "`df -Pk` did not print an available column".to_string(),
    })?;
    if !has_enough_space(est_kb, avail_kb) {
        return Err(BackupError::NotEnoughSpace {
            root: root.to_string(),
            est_kb,
            need_kb: needed_kb(est_kb),
            avail_kb,
        });
    }
    Ok(est_kb)
}

// ---- lock ------------------------------------------------------------------

/// Замок — КАТАЛОГ, и создаётся он без `-p`.
///
/// `mkdir` каталога на POSIX атомарен: либо создал, либо «уже есть», третьего
/// нет. Пара `test -f && touch` атомарной не бывает — два десктопа, нажавшие
/// кнопку одновременно, оба увидели бы «файла нет».
///
/// `-p` есть только у корня: сам замок обязан падать, если он уже есть, — в
/// этом весь смысл. `chmod` корня отдельной командой, потому что `-m` действует
/// только на СОЗДАВАЕМЫЙ каталог: корень, оставшийся от прошлых прогонов с
/// правами пошире, иначе так и остался бы читаемым, а внутри лежат дампы баз.
pub fn build_lock_cmd(root: &str, work: &str) -> String {
    format!(
        "mkdir -m 700 -p {} && chmod 700 {} && mkdir -m 700 {}",
        q(root),
        q(root),
        q(work)
    )
}

/// Кто держит замок и как давно. Возраст считается ПО ЧАСАМ СЕРВЕРА (печатаем и
/// `stat -c %Y`, и `date +%s`): расхождение часов десктопа и сервера иначе
/// превратило бы свежий замок в «просроченный» и наоборот.
pub fn build_lock_probe_cmd(work: &str) -> String {
    format!(
        "if [ -d {w} ]; then printf '{LOCK_MARKER}\\t%s\\t%s\\n' \"$(stat -c %Y {w} 2>/dev/null)\" \"$(date +%s)\"; \
         else printf '{LOCK_MARKER}\\tNONE\\tNONE\\n'; fi",
        w = q(work)
    )
}

/// `None` — каталога нет; `Some(секунды)` — есть и вот его возраст.
pub fn parse_lock_probe(output: &str) -> Option<Option<i64>> {
    let line = output.lines().find(|l| l.trim().starts_with(LOCK_MARKER))?;
    let mut it = line.trim().split('\t').skip(1);
    let mtime = it.next()?.trim();
    let now = it.next()?.trim();
    if mtime == "NONE" {
        return Some(None);
    }
    let mtime: i64 = mtime.parse().ok()?;
    let now: i64 = now.parse().ok()?;
    Some(Some(now - mtime))
}

/// Человеческое описание состояния замка. Просроченный НЕ сносится: автоснос
/// убил бы чужой идущий бэкап (второй десктоп, тот же сервер), а перезапущенный
/// десктоп своим замком не владеет и знать, «мой» он или нет, не может.
pub(crate) fn lock_state_text(age_secs: Option<i64>) -> String {
    let stale = BACKUP_LOCK_STALE_AFTER.as_secs() as i64;
    match age_secs {
        None => "age unknown".to_string(),
        Some(a) if a < 0 => "created in the future (the server clock moved)".to_string(),
        Some(a) if a >= stale => format!(
            "created {}h ago, past the {}h staleness mark — most likely left over from a run that died",
            a / 3600,
            stale / 3600
        ),
        Some(a) => format!(
            "created {} min ago — a backup of this domain is most likely still running",
            a / 60
        ),
    }
}

pub(crate) async fn acquire_lock(
    s: &mut impl Exec,
    paths: &BackupPaths,
) -> Result<(), BackupError> {
    let (code, out) = s
        .run(
            &build_lock_cmd(&paths.root, &paths.work),
            BACKUP_STEP_TIMEOUT,
        )
        .await?;
    if code == 0 {
        return Ok(());
    }
    let (_, probe) = s
        .run(&build_lock_probe_cmd(&paths.work), BACKUP_STEP_TIMEOUT)
        .await?;
    match parse_lock_probe(&probe) {
        // Каталога нет, а `mkdir` всё равно не смог — это не занятый замок, а
        // сломанный `/var/tmp` (только чтение, кончились иноды, ФС в r/o).
        Some(None) | None => Err(BackupError::Step {
            step: "lock",
            detail: format!("mkdir {} exited {code}: {}", paths.work, trim_detail(&out)),
        }),
        Some(age) => Err(BackupError::LockHeld {
            path: paths.work.clone(),
            state: lock_state_text(age),
        }),
    }
}

// ---- архивирование ---------------------------------------------------------

/// Конвейер файлов сайта.
///
/// `gzip -1`, `nice -n 19`, `ionice -c3` — не микрооптимизация: на том же
/// сервере в этот момент живёт продакшн-сайт, и максимальное сжатие с обычным
/// приоритетом съело бы ему и процессор, и диск. `-1` вместо `-9` меняет размер
/// архива на проценты, а нагрузку — в разы.
///
/// `umask 077` — внутри рабочего каталога лежат дампы баз; создаваться они
/// обязаны нечитаемыми для остальных пользователей сервера.
///
/// `--warning=no-file-changed` глушит поток предупреждений на живом сайте, но
/// НЕ меняет код возврата: «файлы менялись при чтении» так и остаётся кодом 1,
/// который мы разбираем отдельно.
pub(crate) fn build_archive_files_cmd(
    site_path: &str,
    work: &str,
    tools: BackupTools,
) -> Option<String> {
    let p = Path::new(site_path);
    let parent = p.parent()?.to_str()?;
    let base = p.file_name()?.to_str()?;
    let mut prefix = String::new();
    if tools.nice {
        prefix.push_str("nice -n 19 ");
    }
    if tools.ionice {
        prefix.push_str("ionice -c3 ");
    }
    Some(format!(
        "set -o pipefail; umask 077; {prefix}tar --warning=no-file-changed -cf - -C {} {} | gzip -1 > {}; {PIPE_STATUS_TAIL}",
        q(parent),
        q(base),
        q(&format!("{work}/{SITE_PART}"))
    ))
}

/// Дамп одной базы.
///
/// **Пароля в argv нет и не будет.** `mysqldump -p<пароль>` виден в `ps` всем
/// пользователям сервера всё время дампа — то есть минуты, а не мгновение, как
/// разовое эхо argv у FastPanel CLI (`docs/FASTPANEL_CLI.md` §7). Идём под
/// root через unix-сокет, ровно тем же способом, каким уже работает
/// `list_site_databases`. Если сокет-авторизация не настроена, шаг честно
/// падает: тихого фолбэка на пароль в argv здесь нет ни одного, и
/// `db_password_blob_id` мы не расшифровываем вовсе.
pub(crate) fn build_dump_db_cmd(db: &str, work: &str) -> String {
    format!(
        "set -o pipefail; umask 077; mysqldump --single-transaction --quick --routines \
         --triggers --events {} | gzip -1 > {}; {PIPE_STATUS_TAIL}",
        q(db),
        q(&format!("{}/{}", work, db_part_name(db)))
    )
}

/// Коды звеньев конвейера из строки-маркера.
pub fn parse_pipeline_status(output: &str) -> Option<Vec<i32>> {
    let line = output.lines().find(|l| l.trim().starts_with(RC_MARKER))?;
    let rest = line.trim().split_once('\t')?.1;
    let codes: Vec<i32> = rest
        .split_whitespace()
        .filter_map(|t| t.parse::<i32>().ok())
        .collect();
    if codes.is_empty() {
        None
    } else {
        Some(codes)
    }
}

/// Исход конвейера `tar | gzip`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PipeOutcome {
    Ok,
    /// Прошло, но с оговоркой (текст уже готов для показа человеку).
    Warned(String),
    Failed(String),
}

/// Классификация кодов `tar`.
///
/// 0 — всё; **1 — «файлы менялись, пока их читали»**, а это на живом сайте
/// норма (php пишет сессии и кэш прямо во время `tar`), поэтому предупреждение,
/// а не отказ; 2 и выше — настоящая ошибка (нет доступа, кончилось место).
///
/// Код `gzip` смотрится ОТДЕЛЬНО и любой ненулевой — отказ: у `gzip` нет
/// «мягких» кодов, а его падение (диск) означает обрезанный архив.
pub(crate) fn classify_tar_status(codes: &[i32]) -> PipeOutcome {
    let tar = codes.first().copied().unwrap_or(-1);
    let gzip = codes.get(1).copied().unwrap_or(-1);
    if gzip != 0 {
        return PipeOutcome::Failed(format!(
            "gzip exited {gzip} while compressing the site files"
        ));
    }
    match tar {
        0 => PipeOutcome::Ok,
        1 => PipeOutcome::Warned(
            "some files changed while tar was reading them — the archive holds the version \
             tar saw first"
                .to_string(),
        ),
        other => PipeOutcome::Failed(format!("tar exited {other}")),
    }
}

/// У `mysqldump` мягких кодов нет: любой ненулевой — отказ.
pub(crate) fn classify_dump_status(db: &str, codes: &[i32]) -> PipeOutcome {
    let dump = codes.first().copied().unwrap_or(-1);
    let gzip = codes.get(1).copied().unwrap_or(-1);
    if dump != 0 {
        return PipeOutcome::Failed(format!(
            "mysqldump exited {dump} for database {db} (SDMP dumps through the root unix socket \
             and never puts a password in argv — check socket authentication)"
        ));
    }
    if gzip != 0 {
        return PipeOutcome::Failed(format!("gzip exited {gzip} while compressing {db}"));
    }
    PipeOutcome::Ok
}

// ---- манифест и упаковка ---------------------------------------------------

/// Контрольные суммы частей — до манифеста, потому что они в нём и лежат.
pub(crate) fn build_hash_parts_cmd(work: &str, parts: &[String]) -> String {
    let names: Vec<String> = parts.iter().map(|p| q(p)).collect();
    format!("cd {} && sha256sum {}", q(work), names.join(" "))
}

/// `sha256sum` печатает `<хеш>␠␠<имя>`.
pub(crate) fn parse_sha256_lines(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|l| {
            let mut it = l.trim().split_whitespace();
            let hash = it.next()?;
            let name = it.next()?;
            if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            Some((
                name.trim_start_matches('*').to_string(),
                hash.to_lowercase(),
            ))
        })
        .collect()
}

/// Манифест. Пишется РЯДОМ с частями и попадает в архив первым файлом.
///
/// Смысл: человек, открывший архив через полгода, должен понять, что это и куда
/// разворачивать, не заглядывая в SDMP, — отсюда и путь сайта, и список баз, и
/// суммы каждой части (по ним видно, что архив цел, даже если SDMP рядом нет).
pub(crate) fn manifest_json(
    domain: &str,
    created_at: DateTime<Utc>,
    site_path: &str,
    databases: &[String],
    parts: &[BackupPart],
    tool: &str,
) -> String {
    serde_json::json!({
        "format": BACKUP_MANIFEST_FORMAT,
        "domain": domain,
        "created_at": created_at.to_rfc3339_opts(SecondsFormat::Secs, true),
        "site_path": site_path,
        "databases": databases,
        "parts": parts,
        "tool": tool,
    })
    .to_string()
}

/// Запись манифеста и упаковка.
///
/// Имена частей перечислены ЯВНО, без `*.gz`: glob раскрывает шелл по тому, что
/// лежит в каталоге на момент запуска, — и чужой файл, попавший туда, уехал бы
/// в архив, а пропавший наш не был бы замечен вовсе. Явный список падает, если
/// части нет.
///
/// `printf '%s\n' <json>` вместо heredoc: json уходит одним аргументом через
/// `q()`, а формат остаётся константой — подставить в него `%` из данных нельзя
/// по построению.
pub(crate) fn build_manifest_and_pack_cmd(
    work: &str,
    archive: &str,
    manifest: &str,
    parts: &[String],
) -> String {
    let mut names: Vec<String> = vec![q(MANIFEST_PART)];
    names.extend(parts.iter().map(|p| q(p)));
    format!(
        "umask 077; printf '%s\\n' {} > {} && tar -cf {} -C {} {}",
        q(manifest),
        q(&format!("{work}/{MANIFEST_PART}")),
        q(archive),
        q(work),
        names.join(" ")
    )
}

pub(crate) fn build_checksum_cmd(archive: &str) -> String {
    format!("sha256sum {a} && stat -c %s {a}", a = q(archive))
}

/// `(sha256, размер)` готового архива.
pub(crate) fn parse_archive_checksum(output: &str) -> Option<(String, u64)> {
    let sha = parse_sha256_lines(output).into_iter().next()?.1;
    let bytes = output
        .lines()
        .rev()
        .filter_map(|l| l.trim().parse::<u64>().ok())
        .next()?;
    Some((sha, bytes))
}

/// Уборка. `archive: Some(...)` — снести и недоделанный архив.
///
/// Рабочий каталог он же замок, поэтому уборка — это ещё и снятие замка; они
/// обязаны быть одним действием, иначе однажды останется одно без другого.
pub fn build_cleanup_cmd(work: &str, archive: Option<&str>) -> String {
    match archive {
        Some(a) => format!("rm -rf {} {}", q(work), q(a)),
        None => format!("rm -rf {}", q(work)),
    }
}

async fn cleanup(
    s: &mut impl Exec,
    paths: &BackupPaths,
    keep_archive: bool,
) -> Result<(), BackupError> {
    let archive = if keep_archive {
        None
    } else {
        Some(paths.archive.as_str())
    };
    let (code, out) = s
        .run(
            &build_cleanup_cmd(&paths.work, archive),
            BACKUP_STEP_TIMEOUT,
        )
        .await?;
    if code != 0 {
        return Err(BackupError::Step {
            step: "cleanup",
            detail: format!("rm -rf exited {code}: {}", trim_detail(&out)),
        });
    }
    Ok(())
}

fn trim_detail(out: &str) -> String {
    let t = out.trim();
    let cut: String = t.chars().take(300).collect();
    cut.replace('\n', " ")
}

// ---- прогон целиком --------------------------------------------------------

/// Сделать архив домена на сервере.
///
/// `now` параметром, а не `Utc::now()` внутри: от него зависят и имя файла, и
/// `created_at` в манифесте, а проверяемым это делает только инъекция.
///
/// Идемпотентность у бэкапа трёхслойная, и здесь живёт первый слой —
/// замок-каталог на сервере. Он единственный переживает перезапуск десктопа и
/// единственный ловит ВТОРОЙ десктоп на том же сервере. Остальные два слоя
/// (реестр прогонов в managed state Tauri и `runExclusive` во фронте) — не
/// дублирование, а более ранние и более дешёвые ступени.
pub async fn create_backup(
    s: &mut impl Exec,
    fp_path: &str,
    domain: &str,
    now: DateTime<Utc>,
) -> Result<BackupArtifact, BackupError> {
    let target = resolve_target(s, fp_path, domain).await?;
    let tools = probe_tools(s, !target.databases.is_empty()).await?;
    let paths = BackupPaths::new(domain, now);
    check_space(s, &target.site_path, &paths.root).await?;

    // С этой секунды на сервере есть наш каталог, и убрать его обязаны мы — на
    // ЛЮБОМ пути выхода. Поэтому дальше ни одного `?`: работа уходит в
    // `run_locked`, а её исход разбирается после уборки.
    acquire_lock(s, &paths).await?;
    let outcome = run_locked(s, &target, tools, &paths, domain, now).await;
    let cleanup_err = cleanup(s, &paths, outcome.is_ok()).await.err();

    match outcome {
        Ok(mut art) => {
            if let Some(e) = cleanup_err {
                // Архив цел, но замок остался на сервере — следующий прогон
                // упрётся в него. Это обязано быть видно.
                art.warnings.push(format!("{e}"));
            }
            Ok(art)
        }
        // Причина отказа важнее неудачи уборки и не подменяется ею: оставшийся
        // замок назовёт следующий прогон — ошибкой `LockHeld`, где есть и путь,
        // и что с ним делать.
        Err(e) => Err(e),
    }
}

async fn run_locked(
    s: &mut impl Exec,
    target: &BackupTarget,
    tools: BackupTools,
    paths: &BackupPaths,
    domain: &str,
    now: DateTime<Utc>,
) -> Result<BackupArtifact, BackupError> {
    let mut warnings: Vec<String> = Vec::new();
    if !tools.ionice {
        warnings.push("ionice is not installed — disk load was not lowered".to_string());
    }
    if !tools.nice {
        warnings.push("nice is not installed — CPU priority was not lowered".to_string());
    }

    // 1. Файлы сайта.
    let cmd = build_archive_files_cmd(&target.site_path, &paths.work, tools).ok_or_else(|| {
        BackupError::UnsafeSitePath {
            path: target.site_path.clone(),
        }
    })?;
    let (code, out) = s.run(&cmd, BACKUP_ARCHIVE_TIMEOUT).await?;
    // Убитый шелл маркера не печатает вовсе, и разбор ниже упёрся бы в «не
    // поняли вывод». Называем причину точнее, пока она известна.
    ensure_exit_status_arrived("archive_files", code)?;
    let codes = parse_pipeline_status(&out).ok_or_else(|| BackupError::Unreadable {
        step: "archive_files",
        detail: format!(
            "the pipeline did not report per-stage exit codes: {}",
            trim_detail(&out)
        ),
    })?;
    match classify_tar_status(&codes) {
        PipeOutcome::Ok => {}
        PipeOutcome::Warned(w) => warnings.push(w),
        PipeOutcome::Failed(detail) => {
            return Err(BackupError::Step {
                step: "archive_files",
                detail,
            })
        }
    }

    // 2. Базы — по одной, каждая отдельным дампом.
    let mut part_names: Vec<String> = vec![SITE_PART.to_string()];
    for db in &target.databases {
        let cmd = build_dump_db_cmd(db, &paths.work);
        let (code, out) = s.run(&cmd, BACKUP_ARCHIVE_TIMEOUT).await?;
        ensure_exit_status_arrived("dump_db", code)?;
        let codes = parse_pipeline_status(&out).ok_or_else(|| BackupError::Unreadable {
            step: "dump_db",
            detail: format!(
                "the pipeline did not report per-stage exit codes: {}",
                trim_detail(&out)
            ),
        })?;
        match classify_dump_status(db, &codes) {
            PipeOutcome::Ok => {}
            PipeOutcome::Warned(w) => warnings.push(w),
            PipeOutcome::Failed(detail) => {
                return Err(BackupError::Step {
                    step: "dump_db",
                    detail,
                })
            }
        }
        part_names.push(db_part_name(db));
    }

    // 3. Суммы частей — вход манифеста.
    let (code, out) = s
        .run(
            &build_hash_parts_cmd(&paths.work, &part_names),
            BACKUP_STEP_TIMEOUT,
        )
        .await?;
    if code != 0 {
        return Err(BackupError::Step {
            step: "manifest",
            detail: format!(
                "sha256sum of the parts exited {code}: {}",
                trim_detail(&out)
            ),
        });
    }
    let hashes = parse_sha256_lines(&out);
    let mut parts: Vec<BackupPart> = Vec::new();
    for name in &part_names {
        let sha = hashes
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, h)| h.clone())
            .ok_or_else(|| BackupError::Unreadable {
                step: "manifest",
                detail: format!("no sha256 for part {name}"),
            })?;
        parts.push(BackupPart {
            name: name.clone(),
            kind: if name == SITE_PART {
                "files"
            } else {
                "database"
            }
            .to_string(),
            sha256: sha,
        });
    }

    // 4. Манифест + упаковка.
    let manifest = manifest_json(
        domain,
        now,
        &target.site_path,
        &target.databases,
        &parts,
        BACKUP_TOOL,
    );
    let (code, out) = s
        .run(
            &build_manifest_and_pack_cmd(&paths.work, &paths.archive, &manifest, &part_names),
            BACKUP_ARCHIVE_TIMEOUT,
        )
        .await?;
    if code != 0 {
        return Err(BackupError::Step {
            step: "pack",
            detail: format!("packing exited {code}: {}", trim_detail(&out)),
        });
    }

    // 5. Контрольная сумма готового архива. Считается ЗДЕСЬ, на сервере, до
    //    любой выгрузки: только так скачавший может доказать, что довёз файл
    //    целиком (фаза 4 сверяет с ней локально посчитанную).
    let (code, out) = s
        .run(&build_checksum_cmd(&paths.archive), BACKUP_STEP_TIMEOUT)
        .await?;
    if code != 0 {
        return Err(BackupError::Step {
            step: "checksum",
            detail: format!("sha256sum/stat exited {code}: {}", trim_detail(&out)),
        });
    }
    let (sha256, bytes) = parse_archive_checksum(&out).ok_or_else(|| BackupError::Unreadable {
        step: "checksum",
        detail: format!("no sha256 and size in: {}", trim_detail(&out)),
    })?;

    Ok(BackupArtifact {
        path: paths.archive.clone(),
        file_name: paths.file_name.clone(),
        bytes,
        sha256,
        parts,
        databases: target.databases.clone(),
        site_path: target.site_path.clone(),
        created_at: now,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use chrono::TimeZone;

    const FP: &str = "/usr/local/fastpanel2/fastpanel";

    /// Две реальные строки `sites list --json` (discovery 2026-08-16) —
    /// `index_dir` тут настоящий.
    const SITES_JSON: &str = r#"[
      {"id":3,"domain":"example.com",
       "index_dir":"/var/www/example_usr/data/www/example.com",
       "main_backend":{"handler":"mpm_itk","handler_version":"7.4"},
       "owner":{"id":5,"username":"example_usr","home_dir":"/var/www/example_usr/data"}},
      {"id":8,"domain":"example.com.old",
       "index_dir":"/var/www/old_usr/data/www/example.com.old",
       "main_backend":{"handler":"php_fpm","handler_version":"8.1"},
       "owner":{"id":10,"username":"old_usr","home_dir":"/var/www/old_usr/data"}}
    ]"#;

    /// `databases list --json` по форме findings: имена усечены, привязка через
    /// `site.domain`.
    const DB_JSON: &str = r#"[
      {"id":1,"name":"exmpldb","site":{"id":3,"domain":"example.com"},
       "owner":{"username":"example_usr"},"server":{"type":"mysql"}},
      {"id":2,"name":"oldsitedb","site":{"id":8,"domain":"example.com.old"},
       "owner":{"username":"old_usr"},"server":{"type":"mysql"}}
    ]"#;

    const TOOLS_ALL_OK: &str =
        "tar\tOK\ngzip\tOK\nsha256sum\tOK\ndu\tOK\ndf\tOK\nmysqldump\tOK\nnice\tOK\nionice\tOK";

    const SPACE_OK: &str = "SDMP_DU\n1000\t/var/www/example_usr/data/www/example.com\nSDMP_DF\n\
        Filesystem 1024-blocks Used Available Capacity Mounted on\n\
        /dev/sda1 50000000 1000000 40000000 3% /var";

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 8, 19, 10, 30, 0).unwrap()
    }

    // ---- фейковый сервер: отвечает по подстроке, помнит УШЕДШИЕ строки ------

    struct FakeServer {
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

        /// Полный набор ответов «всё хорошо». Тесты подменяют отдельные строки.
        fn happy() -> Self {
            FakeServer::new(&[
                ("sites list --json", 0, SITES_JSON),
                ("databases list --json", 0, DB_JSON),
                ("command -v", 0, TOOLS_ALL_OK),
                (DU_MARKER, 0, SPACE_OK),
                ("mkdir -m 700", 0, ""),
                ("tar --warning=no-file-changed", 0, "SDMP_RC\t0 0"),
                ("mysqldump", 0, "SDMP_RC\t0 0"),
                (
                    "&& sha256sum",
                    0,
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  site.tar.gz\n\
                     bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  db-exmpldb.sql.gz",
                ),
                ("tar -cf", 0, ""),
                (
                    "stat -c %s",
                    0,
                    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  /var/tmp/sdmp-backup/example.com-20260819T103000Z.tar\n4096",
                ),
                ("rm -rf", 0, ""),
            ])
        }

        fn reply(&mut self, pat: &'static str, code: i32, out: &str) -> &mut Self {
            // В начало: первое совпадение выигрывает.
            self.replies.insert(0, (pat, code, out.to_string()));
            self
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

    /// Одинарные кавычки сбалансированы (экранированные `\'` не в счёт) — то
    /// есть строка действительно прошла через `q()`, а не склеена руками.
    fn quotes_are_balanced(cmd: &str) -> bool {
        let b: Vec<char> = cmd.chars().collect();
        let mut n = 0usize;
        for (i, c) in b.iter().enumerate() {
            if *c == '\'' && (i == 0 || b[i - 1] != '\\') {
                n += 1;
            }
        }
        n % 2 == 0
    }

    // ---- квотирование -------------------------------------------------------

    // Домен с пробелом и апострофом — единственный способ доказать, что `q()`
    // применён ко ВСЕМ интерполяциям, а не к тем, о которых вспомнили. Гоняем
    // весь прогон и смотрим на РЕАЛЬНО ушедшие строки.
    #[tokio::test]
    async fn every_interpolation_goes_through_the_shell_quoter() {
        let evil = "a b'c";
        let sites = r#"[{"id":1,"domain":"a b'c","index_dir":"/var/www/x_usr/data/www/a b'c"}]"#;
        let dbs = r#"[{"id":1,"name":"evil_db","site":{"id":1,"domain":"a b'c"}}]"#;
        let mut s = FakeServer::happy();
        s.reply("sites list --json", 0, sites)
            .reply("databases list --json", 0, dbs)
            .reply(
                "&& sha256sum",
                0,
                &format!("{HASH_A}  site.tar.gz\n{HASH_B}  db-evil_db.sql.gz"),
            );

        let art = create_backup(&mut s, FP, evil, now()).await.unwrap();
        assert_eq!(art.site_path, "/var/www/x_usr/data/www/a b'c");

        for cmd in &s.seen {
            assert!(quotes_are_balanced(cmd), "кавычки не сбалансированы: {cmd}");
            // Сырой домен в команде означал бы интерполяцию мимо `q()`:
            // после экранирования он выглядит как `a b'\''c`.
            assert!(
                !cmd.contains("a b'c") || cmd.contains("'a b'\\''c'"),
                "домен подставлен без экранирования: {cmd}"
            );
        }
        // Опасный домен не должен попасть в путь на сервере вообще.
        assert!(s
            .seen
            .iter()
            .any(|c| c.contains("/var/tmp/sdmp-backup/a_b_c")));
    }

    #[test]
    fn both_pipelines_ask_the_shell_for_honest_exit_codes() {
        let files = build_archive_files_cmd(
            "/var/www/u/data/www/example.com",
            "/var/tmp/sdmp-backup/example.com",
            BackupTools {
                nice: true,
                ionice: true,
            },
        )
        .unwrap();
        let dump = build_dump_db_cmd("exmpldb", "/var/tmp/sdmp-backup/example.com");
        for cmd in [&files, &dump] {
            assert!(cmd.starts_with("set -o pipefail;"), "нет pipefail: {cmd}");
            assert!(cmd.contains("PIPESTATUS"), "нет PIPESTATUS: {cmd}");
            assert!(cmd.contains("umask 077"), "нет umask: {cmd}");
            assert!(cmd.contains("| gzip -1 >"), "нет gzip -1: {cmd}");
        }
        assert!(files.contains("nice -n 19 ionice -c3 tar"));
        // Пароля в argv дампа нет ни в каком виде — это главное решение шага.
        assert!(!dump.contains("-p"), "подозрение на пароль в argv: {dump}");
        assert!(!dump.contains("password"));
    }

    #[test]
    fn a_server_without_nice_still_gets_a_backup() {
        let cmd = build_archive_files_cmd(
            "/var/www/u/data/www/example.com",
            "/w",
            BackupTools {
                nice: false,
                ionice: false,
            },
        )
        .unwrap();
        assert!(cmd.contains("umask 077; tar --warning"));
    }

    // ---- коды tar -----------------------------------------------------------

    #[test]
    fn tar_code_one_is_a_warning_and_two_is_a_refusal() {
        assert_eq!(classify_tar_status(&[0, 0]), PipeOutcome::Ok);
        assert!(matches!(
            classify_tar_status(&[1, 0]),
            PipeOutcome::Warned(_)
        ));
        assert!(matches!(
            classify_tar_status(&[2, 0]),
            PipeOutcome::Failed(_)
        ));
        assert!(matches!(
            classify_tar_status(&[3, 0]),
            PipeOutcome::Failed(_)
        ));
        // Упавший `gzip` при «мягком» коде tar — отказ, а не предупреждение:
        // ровно так выглядит кончившееся место, и архив тогда обрезан.
        assert!(matches!(
            classify_tar_status(&[1, 1]),
            PipeOutcome::Failed(_)
        ));
        // Маркер не доехал — коды разобрать не из чего.
        assert_eq!(parse_pipeline_status("tar: something\n"), None);
        assert_eq!(parse_pipeline_status("SDMP_RC\t1 0"), Some(vec![1, 0]));
    }

    #[tokio::test]
    async fn a_changed_file_warns_but_a_broken_tar_refuses() {
        let mut s = FakeServer::happy();
        s.reply("tar --warning=no-file-changed", 0, "SDMP_RC\t1 0");
        let art = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap();
        assert_eq!(art.warnings.len(), 1);
        assert!(art.warnings[0].contains("changed while tar was reading"));

        let mut s = FakeServer::happy();
        s.reply("tar --warning=no-file-changed", 0, "SDMP_RC\t2 0");
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            BackupError::Step {
                step: "archive_files",
                ..
            }
        ));
    }

    // ---- место --------------------------------------------------------------

    #[test]
    fn free_space_is_decided_on_the_boundary() {
        // Ровно 1.2× — этого хватает.
        assert!(has_enough_space(1000, 1200));
        assert!(!has_enough_space(1000, 1199));
        assert!(has_enough_space(1000, 1201));
        assert_eq!(needed_kb(1000), 1200);
        // Округление вверх, а не вниз.
        assert_eq!(needed_kb(1), 2);
    }

    #[test]
    fn space_output_is_read_by_section_not_by_luck() {
        let out = "SDMP_DU\ndu: cannot read '/x'\n204800\t/var/www/u/data/www/example.com\n\
                   SDMP_DF\nFilesystem 1024-blocks Used Available Capacity Mounted on\n\
                   /dev/sda1 50000000 1000000 40000000 3% /var";
        assert_eq!(parse_du_kb(out), Some(204800));
        assert_eq!(parse_df_avail_kb(out), Some(40000000));
        // Размер сайта не должен утечь в «свободно» и наоборот.
        assert_eq!(parse_du_kb("SDMP_DF\n/dev/sda1 1 2 3 4% /"), None);
    }

    #[tokio::test]
    async fn a_full_disk_stops_the_backup_before_the_lock() {
        let mut s = FakeServer::happy();
        s.reply(
            DU_MARKER,
            0,
            "SDMP_DU\n1000000\t/site\nSDMP_DF\nFilesystem 1024-blocks Used Available Capacity Mounted on\n\
             /dev/sda1 5000000 4000000 1000000 80% /var",
        );
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(matches!(err, BackupError::NotEnoughSpace { .. }));
        // Замка не было — значит и убирать нечего.
        assert!(!s.seen.iter().any(|c| c.contains("mkdir -m 700")));
        assert!(!s.seen.iter().any(|c| c.contains("rm -rf")));
    }

    // ---- фильтр по домену ---------------------------------------------------

    #[test]
    fn the_database_filter_does_not_catch_a_lookalike_domain() {
        assert_eq!(
            databases_for_backup(DB_JSON, "example.com"),
            Some(vec!["exmpldb".to_string()])
        );
        assert_eq!(
            databases_for_backup(DB_JSON, "example.com.old"),
            Some(vec!["oldsitedb".to_string()])
        );
        // Домена нет вовсе — это ответ «баз нет», форма при этом понята.
        assert_eq!(
            databases_for_backup(DB_JSON, "other.tld"),
            Some(Vec::<String>::new())
        );
    }

    #[test]
    fn unknown_output_shape_is_not_an_empty_list() {
        // Массив пуст — панель ответила «баз нет».
        assert_eq!(databases_for_backup("[]", "example.com"), Some(vec![]));
        // Массив непуст, но ни одной узнаваемой строки — форма чужая.
        assert_eq!(
            databases_for_backup(r#"[{"db":"x"},{"db":"y"}]"#, "example.com"),
            None
        );
        // Наша строка есть, а имени в ней нет — потерять базу молча нельзя.
        assert_eq!(
            databases_for_backup(r#"[{"site":{"domain":"example.com"}}]"#, "example.com"),
            None
        );
        // Не JSON вовсе.
        assert_eq!(
            databases_for_backup(
                "error: expected command but got \"database\"",
                "example.com"
            ),
            None
        );
    }

    #[tokio::test]
    async fn databases_we_cannot_read_stop_the_backup() {
        for (code, out) in [
            (1, "expected command but got \"database\""),
            (0, "[{\"db\":\"x\"}]"),
        ] {
            let mut s = FakeServer::happy();
            s.reply("databases list --json", code, out);
            let err = create_backup(&mut s, FP, "example.com", now())
                .await
                .unwrap_err();
            assert!(
                matches!(err, BackupError::DatabasesUnknown { .. }),
                "неожиданная ошибка: {err}"
            );
            // Ни `tar`, ни замка: отказ случился до всего.
            assert!(!s.seen.iter().any(|c| c.contains("mkdir -m 700")));
        }
    }

    #[test]
    fn the_site_path_comes_from_index_dir() {
        let row = find_site_row(SITES_JSON, "example.com").unwrap();
        assert_eq!(
            site_path_from_row(&row).as_deref(),
            Some("/var/www/example_usr/data/www/example.com")
        );
        assert!(site_path_is_sane("/var/www/u/data/www/example.com"));
        // Пол-сервера архивировать не будем.
        assert!(!site_path_is_sane("/"));
        assert!(!site_path_is_sane("/var/www"));
        assert!(!site_path_is_sane("relative/path/here"));
        assert!(!site_path_is_sane("/var/www/u/../../etc"));
    }

    // ---- манифест -----------------------------------------------------------

    #[test]
    fn the_manifest_names_every_part_and_survives_a_hostile_domain() {
        let parts = vec![
            BackupPart {
                name: SITE_PART.to_string(),
                kind: "files".to_string(),
                sha256: HASH_A.to_string(),
            },
            BackupPart {
                name: "db-exmpldb.sql.gz".to_string(),
                kind: "database".to_string(),
                sha256: HASH_B.to_string(),
            },
        ];
        let json = manifest_json(
            "a b'c\"quote",
            now(),
            "/var/www/u/data/www/example.com",
            &["exmpldb".to_string()],
            &parts,
            "sdmp-desktop/0.0.0",
        );
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["format"], BACKUP_MANIFEST_FORMAT);
        assert_eq!(v["domain"], "a b'c\"quote");
        assert_eq!(v["created_at"], "2026-08-19T10:30:00Z");
        assert_eq!(v["site_path"], "/var/www/u/data/www/example.com");
        assert_eq!(v["databases"][0], "exmpldb");
        assert_eq!(v["parts"].as_array().unwrap().len(), 2);
        assert_eq!(v["parts"][1]["kind"], "database");
        assert_eq!(v["parts"][1]["sha256"], HASH_B);
        assert!(v["tool"].as_str().unwrap().starts_with("sdmp-desktop/"));

        // И этот json уезжает на сервер одним экранированным аргументом.
        let cmd = build_manifest_and_pack_cmd(
            "/w",
            "/a.tar",
            &json,
            &[SITE_PART.to_string(), "db-exmpldb.sql.gz".to_string()],
        );
        assert!(quotes_are_balanced(&cmd), "{cmd}");
        assert!(cmd.contains("printf '%s\\n' '"));
    }

    #[test]
    fn packing_lists_the_parts_explicitly_and_never_globs() {
        let cmd = build_manifest_and_pack_cmd(
            "/w",
            "/a.tar",
            "{}",
            &[SITE_PART.to_string(), "db-x.sql.gz".to_string()],
        );
        // `q()` не навешивает кавычки на то, что в них не нуждается, — важна не
        // форма, а то, что каждое имя прошло через квотирование и осталось
        // отдельным аргументом.
        assert!(
            cmd.contains("tar -cf /a.tar -C /w manifest.json site.tar.gz db-x.sql.gz"),
            "{cmd}"
        );
        assert!(!cmd.contains('*'), "glob в упаковке: {cmd}");
    }

    #[test]
    fn checksums_are_read_from_real_sha256sum_output() {
        let out = format!("{HASH_C}  /var/tmp/sdmp-backup/example.com-x.tar\n4096\n");
        assert_eq!(
            parse_archive_checksum(&out),
            Some((HASH_C.to_string(), 4096))
        );
        // Не хеш — не берём.
        assert_eq!(parse_archive_checksum("nope  file\n12"), None);
        assert_eq!(
            parse_sha256_lines(&format!("{HASH_A}  site.tar.gz")),
            vec![("site.tar.gz".to_string(), HASH_A.to_string())]
        );
    }

    // ---- замок --------------------------------------------------------------

    #[test]
    fn the_lock_is_a_directory_created_without_dash_p() {
        let cmd = build_lock_cmd("/var/tmp/sdmp-backup", "/var/tmp/sdmp-backup/example.com");
        assert!(
            cmd.contains("mkdir -m 700 -p /var/tmp/sdmp-backup &&"),
            "{cmd}"
        );
        assert!(cmd.contains("chmod 700 /var/tmp/sdmp-backup &&"), "{cmd}");
        // Сам замок — БЕЗ `-p`: иначе повторный вызов молча «успевал» бы.
        assert!(
            cmd.ends_with("mkdir -m 700 /var/tmp/sdmp-backup/example.com"),
            "{cmd}"
        );
    }

    #[tokio::test]
    async fn a_second_backup_of_the_same_domain_is_refused_by_the_lock() {
        let mut s = FakeServer::happy();
        s.reply(
            "mkdir -m 700",
            1,
            "mkdir: cannot create directory: File exists",
        )
        .reply(
            "[ -d ",
            0,
            &format!("SDMP_LOCK\t1000\t{}\n", 1000 + 120), // две минуты назад
        );
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        let text = err.to_string();
        assert!(matches!(err, BackupError::LockHeld { .. }), "{text}");
        assert!(text.contains("/var/tmp/sdmp-backup/example.com"), "{text}");
        assert!(text.contains("still running"), "{text}");
        // Замок чужой — ни `rm`, ни `tar` не случилось.
        assert!(!s.seen.iter().any(|c| c.contains("rm -rf")));
        assert!(!s.seen.iter().any(|c| c.contains("tar --warning")));
    }

    #[tokio::test]
    async fn a_stale_lock_is_named_with_its_path_and_never_removed() {
        let mut s = FakeServer::happy();
        s.reply("mkdir -m 700", 1, "File exists").reply(
            "[ -d ",
            0,
            &format!("SDMP_LOCK\t1000\t{}\n", 1000 + 12 * 3600),
        );
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("12h ago"), "{text}");
        assert!(text.contains("staleness mark"), "{text}");
        // Действенность: путь и ровно то, что человек должен сделать руками.
        assert!(
            text.contains("rm -rf /var/tmp/sdmp-backup/example.com"),
            "{text}"
        );
        assert!(text.contains("never removes this lock by itself"), "{text}");
        // И ни одной команды удаления от нас: автоснос убил бы чужой прогон.
        assert!(!s.seen.iter().any(|c| c.contains("rm ")), "{:?}", s.seen);
    }

    #[test]
    fn lock_age_is_measured_by_the_server_clock() {
        assert_eq!(parse_lock_probe("SDMP_LOCK\t100\t400\n"), Some(Some(300)));
        assert_eq!(parse_lock_probe("SDMP_LOCK\tNONE\tNONE"), Some(None));
        assert_eq!(parse_lock_probe("something else"), None);
        assert!(lock_state_text(Some(-5)).contains("server clock"));
        assert!(lock_state_text(None).contains("unknown"));
    }

    #[tokio::test]
    async fn a_broken_tmp_is_not_reported_as_a_held_lock() {
        let mut s = FakeServer::happy();
        s.reply("mkdir -m 700", 1, "Read-only file system").reply(
            "[ -d ",
            0,
            "SDMP_LOCK\tNONE\tNONE",
        );
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(
            matches!(err, BackupError::Step { step: "lock", .. }),
            "{err}"
        );
    }

    // ---- уборка -------------------------------------------------------------

    #[tokio::test]
    async fn cleanup_happens_on_every_exit_path_after_the_lock() {
        // Отказ на середине (второй шаг из пяти под замком).
        let mut s = FakeServer::happy();
        s.reply("mysqldump", 0, "SDMP_RC\t2 0");
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            BackupError::Step {
                step: "dump_db",
                ..
            }
        ));
        // Рабочий каталог (он же замок) снят, и недоделанный архив тоже.
        let rm = s
            .seen
            .iter()
            .find(|c| c.contains("rm -rf"))
            .expect("уборки не было");
        assert!(
            rm.contains("rm -rf /var/tmp/sdmp-backup/example.com "),
            "{rm}"
        );
        assert!(
            rm.contains("example.com-20260819T103000Z.tar"),
            "недоделанный архив остался: {rm}"
        );
    }

    #[tokio::test]
    async fn a_successful_run_clears_the_lock_and_keeps_the_archive() {
        let mut s = FakeServer::happy();
        let art = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap();
        let rm = s.seen.iter().find(|c| c.contains("rm -rf")).unwrap();
        assert_eq!(rm, "rm -rf /var/tmp/sdmp-backup/example.com");
        assert_eq!(
            art.path,
            "/var/tmp/sdmp-backup/example.com-20260819T103000Z.tar"
        );
        assert!(!rm.contains(&art.file_name), "уборка унесла архив: {rm}");
    }

    #[tokio::test]
    async fn a_lock_that_would_not_clear_is_not_hidden_from_the_caller() {
        let mut s = FakeServer::happy();
        s.reply("rm -rf", 1, "rm: cannot remove");
        let art = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap();
        assert!(
            art.warnings.iter().any(|w| w.contains("cleanup")),
            "{:?}",
            art.warnings
        );
    }

    // ---- инвентарь ----------------------------------------------------------

    #[test]
    fn the_tool_probe_can_actually_tell_a_missing_tool() {
        let cmd = build_tools_probe_cmd(&["tar", "gzip"]);
        assert!(cmd.contains("command -v \"$t\""));
        assert!(quotes_are_balanced(&cmd));
        assert_eq!(
            parse_missing_tools("tar\tOK\ngzip\tMISSING\nionice\tMISSING"),
            vec!["gzip".to_string(), "ionice".to_string()]
        );
    }

    #[tokio::test]
    async fn a_server_without_tar_is_refused_by_name() {
        let mut s = FakeServer::happy();
        s.reply("command -v", 0, "tar\tMISSING\ngzip\tOK\nsha256sum\tOK\ndu\tOK\ndf\tOK\nmysqldump\tOK\nnice\tOK\nionice\tOK");
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("tar"), "{err}");
        assert!(matches!(err, BackupError::MissingTools { .. }));
    }

    #[tokio::test]
    async fn a_missing_ionice_is_a_warning_not_a_refusal() {
        let mut s = FakeServer::happy();
        s.reply(
            "command -v",
            0,
            "tar\tOK\ngzip\tOK\nsha256sum\tOK\ndu\tOK\ndf\tOK\nmysqldump\tOK\nnice\tOK\nionice\tMISSING",
        );
        let art = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap();
        assert!(art.warnings.iter().any(|w| w.contains("ionice")));
        assert!(s
            .seen
            .iter()
            .any(|c| c.contains("nice -n 19 tar --warning")));
    }

    // ---- прогон целиком -----------------------------------------------------

    #[tokio::test]
    async fn the_happy_path_returns_an_artifact_that_describes_the_server_file() {
        let mut s = FakeServer::happy();
        let art = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap();
        assert_eq!(art.file_name, "example.com-20260819T103000Z.tar");
        assert_eq!(art.bytes, 4096);
        assert_eq!(art.sha256, HASH_C);
        assert_eq!(art.databases, vec!["exmpldb".to_string()]);
        assert_eq!(art.site_path, "/var/www/example_usr/data/www/example.com");
        assert_eq!(art.parts.len(), 2);
        assert_eq!(art.parts[0].name, SITE_PART);
        assert_eq!(art.parts[0].kind, "files");
        assert_eq!(art.parts[1].name, "db-exmpldb.sql.gz");
        assert_eq!(art.parts[1].sha256, HASH_B);
        assert!(art.warnings.is_empty());

        // Все девять шагов действительно сходили на сервер, и в порядке.
        let order = [
            "sites list --json",
            "databases list --json",
            "command -v",
            DU_MARKER,
            "mkdir -m 700",
            "tar --warning=no-file-changed",
            "mysqldump",
            "&& sha256sum",
            "tar -cf",
            "stat -c %s",
            "rm -rf",
        ];
        let mut at = 0usize;
        for step in order {
            let found = s.seen[at..]
                .iter()
                .position(|c| c.contains(step))
                .unwrap_or_else(|| panic!("шаг {step} не ушёл на сервер: {:?}", s.seen));
            at += found + 1;
        }
    }

    // Ни одна команда бэкапа не несёт секрета в argv (образец
    // `read_commands_argv_has_no_secret` из `fastpanel_facts`).
    #[tokio::test]
    async fn no_backup_command_carries_a_secret_in_argv() {
        let mut s = FakeServer::happy();
        let _ = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap();
        for cmd in &s.seen {
            assert!(!cmd.contains("--password"), "секрет в argv: {cmd}");
            assert!(!cmd.contains("password="), "секрет в argv: {cmd}");
            assert!(
                !cmd.to_lowercase().contains("identified by"),
                "секрет в argv: {cmd}"
            );
        }
    }

    // Рабочий каталог обязан лежать вне каталога сайта: под document root архив
    // раздаётся по HTTP и попадает внутрь следующего `tar` самого себя.
    #[tokio::test]
    async fn the_work_directory_never_lives_under_the_site() {
        let mut s = FakeServer::happy();
        let art = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap();
        assert!(art.path.starts_with("/var/tmp/sdmp-backup/"));
        assert!(!art.path.starts_with(&art.site_path));
        for cmd in &s.seen {
            assert!(
                !cmd.contains("/data/www/example.com/site.tar.gz"),
                "часть архива под сайтом: {cmd}"
            );
        }
    }

    #[test]
    fn a_domain_can_never_climb_out_of_the_work_root() {
        assert_eq!(safe_component("example.com"), "example.com");
        // Ведущая точка заменена — каталог `..` перестал быть каталогом `..`.
        assert_eq!(safe_component(".."), "_.");
        assert_eq!(safe_component("../../etc"), "_._.._etc");
        assert_eq!(safe_component("a b'c"), "a_b_c");
        assert_eq!(safe_component(""), "_");
        // Точки внутри имени безобидны (`_._.._etc`) — опасен только отдельный
        // сегмент `..`, а он невозможен: `/` тоже заменяется, так что домен
        // всегда остаётся ОДНИМ сегментом внутри рабочего корня.
        let paths = BackupPaths::new("../../etc/passwd", now());
        assert_eq!(paths.work, "/var/tmp/sdmp-backup/_._.._etc_passwd");
        assert!(!paths.work.contains("/.."), "{}", paths.work);
        assert!(!paths.archive.contains("/.."), "{}", paths.archive);
        assert_eq!(
            paths.work.matches('/').count(),
            BACKUP_WORK_ROOT.matches('/').count() + 1
        );
    }

    #[test]
    fn a_database_name_we_would_not_put_in_a_file_name_is_refused() {
        assert!(db_name_is_safe("exmpldb"));
        assert!(db_name_is_safe("site_db-1$"));
        assert!(!db_name_is_safe(""));
        assert!(!db_name_is_safe("../etc/passwd"));
        assert!(!db_name_is_safe("db name"));
        assert_eq!(db_part_name("exmpldb"), "db-exmpldb.sql.gz");
    }

    #[tokio::test]
    async fn a_domain_absent_from_the_panel_is_not_an_empty_backup() {
        let mut s = FakeServer::happy();
        let err = create_backup(&mut s, FP, "nosuch.tld", now())
            .await
            .unwrap_err();
        assert!(matches!(err, BackupError::SiteNotFound { .. }), "{err}");
    }

    // Убитая команда приезжает через `exec` не сигналом, а отсутствием
    // `exit-status`, то есть кодом -1 (`exec_to_writer` отдал бы честное
    // `signal: Some("KILL")`, но качать архив — это фаза 4, здесь весь вывод
    // текстовый). Ни один шаг не имеет права принять такой конец за «просто
    // пустой вывод».
    #[tokio::test]
    async fn a_step_killed_without_an_exit_status_is_never_taken_for_silence() {
        // Шаг, у которого код мы намеренно игнорируем (`du` ненулевой — норма).
        let mut s = FakeServer::happy();
        s.reply(DU_MARKER, NO_EXIT_STATUS, SPACE_OK);
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(
            matches!(err, BackupError::Unreadable { step: "space", .. }),
            "{err}"
        );
        assert!(err.to_string().contains("killed"), "{err}");

        // Инвентарь инструментов — там код тоже не смотрится.
        let mut s = FakeServer::happy();
        s.reply("command -v", NO_EXIT_STATUS, TOOLS_ALL_OK);
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                BackupError::Unreadable {
                    step: "preflight",
                    ..
                }
            ),
            "{err}"
        );

        // Убитый шелл конвейера: маркера нет и итога нет. Уборка при этом
        // обязана состояться — замок уже взят.
        let mut s = FakeServer::happy();
        s.reply("tar --warning=no-file-changed", NO_EXIT_STATUS, "");
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(
            matches!(
                err,
                BackupError::Unreadable {
                    step: "archive_files",
                    ..
                }
            ),
            "{err}"
        );
        assert!(s.seen.iter().any(|c| c.contains("rm -rf")));
    }

    // OOM-killer прибил САМ `tar`, а шелл выжил: bash показывает это в
    // PIPESTATUS как 128+9. Общее правило «≥ 2 — отказ» обязано поймать и это,
    // иначе обрезанный архив уехал бы как здоровый.
    #[tokio::test]
    async fn a_tar_killed_by_the_oom_killer_is_a_refusal_not_a_warning() {
        assert!(matches!(
            classify_tar_status(&[137, 0]),
            PipeOutcome::Failed(_)
        ));
        let mut s = FakeServer::happy();
        s.reply("tar --warning=no-file-changed", 0, "SDMP_RC\t137 0");
        let err = create_backup(&mut s, FP, "example.com", now())
            .await
            .unwrap_err();
        assert!(err.to_string().contains("137"), "{err}");
        assert!(s.seen.iter().any(|c| c.contains("rm -rf")));
    }

    #[test]
    fn timeouts_match_the_shape_of_the_work() {
        // Короткие шаги — минута; всё, что трогает гигабайты, — час.
        assert_eq!(BACKUP_STEP_TIMEOUT, Duration::from_secs(60));
        assert_eq!(BACKUP_ARCHIVE_TIMEOUT, Duration::from_secs(3600));
        // Долгий шаг обязан быть длиннее короткого настолько, чтобы разница была
        // осмысленной, а не опечаткой.
        assert!(BACKUP_ARCHIVE_TIMEOUT >= BACKUP_STEP_TIMEOUT * 10);
    }
}
