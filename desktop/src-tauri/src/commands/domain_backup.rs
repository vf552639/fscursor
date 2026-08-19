//! Tauri-команды бэкапа домена: создать архив на сервере, скачать его на диск
//! пользователя, отменить идущий прогон.
//!
//! Форма списана с [`crate::commands::domain_facts`] дословно: keychain →
//! `cache::open` → `get_row_fields` → `blob_plaintext` → `key.zeroize()` →
//! `drop(conn)` → `ssh_connect_session_with_timeout` → `password.zeroize()` →
//! работа → `disconnect`. Отличий от чтения фактов три, и все три — следствие
//! того, что здесь МУТАЦИЯ, идущая минутами и десятками гигабайт:
//!
//! 1. **Идемпотентность.** Три слоя, и здесь живёт второй: [`BackupRuns`] в
//!    managed state Tauri. Первый (замок-каталог на сервере) сделан ядром
//!    [`crate::ssh::backup_run`] и переживает перезапуск десктопа; третий
//!    (`runExclusive` во фронте) — самый дешёвый и самый ранний. Наш слой
//!    ловит то, что не ловят соседи: второе окно того же десктопа и повторный
//!    вызов мимо фронта.
//! 2. **Отмена.** Гигабайтную выгрузку человек обязан уметь остановить, и
//!    остановка обязана не оставлять мусора: `<dest>.part` удаляется, работа на
//!    сервере убирается, архив с сервера сносится.
//! 3. **Пересъёмка фактов после успеха.** Список копий приезжает из `fp_facts`,
//!    и без пересъёмки экран после удачного бэкапа выглядел бы ровно как до
//!    него.
//!
//! Чего здесь НЕТ намеренно: `domain_backup_fetch` — скачивание копии, которую
//! сделала сама панель (фаза 8 плана). Путь к чужому архиву известен только
//! после живой разведки `scripts/fastpanel-discovery.sh`, а гадать про чужие
//! файлы на продакшне нельзя. Из-за этого [`BackupRuns`] заведён на ДОМЕН, а не
//! на прогон: когда fetch появится, у него будет своя кнопка, но та же SSH-
//! сессия к тому же серверу и та же строка прогресса, и признак занятости у
//! них обязан быть общий.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::commands::auth::CommandError;
use crate::commands::creds::{audit_best_effort, blob_plaintext, cache_path, json_i64, json_str};
use crate::commands::ssh::ssh_connect_session_with_timeout;
use crate::commands::sync_cmd::SyncHandle;
use crate::keychain;
use crate::ssh::backup_download::{self, DownloadError};
use crate::ssh::backup_run::{create_backup, BackupPart, BACKUP_STEP_TIMEOUT, BACKUP_WORK_ROOT};
use crate::ssh::client::SshError;
use crate::ssh::fastpanel::{self, q, Exec};
use crate::ssh::fastpanel_facts;
use crate::sync::cache;
use crate::sync::http::ApiClient;

/// Канал событий прогресса. Свой, а не `provision:progress`: у того свой
/// словарь шагов, и чужие шаги дали бы на экране пустые тосты.
///
/// Полезная нагрузка — `{domain_id, step, done_bytes?, total_bytes?}`. Байты
/// необязательны намеренно: у серверных шагов их нет вовсе, а полоса прогресса
/// со знаменателем «на глаз» — это то же самое, что зелёный бейдж вместо
/// «не проверяли» (принцип №6). Нет знаменателя — фронт рисует шаг словами.
pub const BACKUP_PROGRESS_EVENT: &str = "backup:progress";

/// Словарь шагов — он же контракт с фронтом (фаза 7). Ровно эти строки
/// приезжают в `step`; всё, чего здесь нет, — ошибка на нашей стороне.
pub const BACKUP_STEP_CONNECT: &str = "connect";
/// Сервер собирает архив: `tar`, `mysqldump`, упаковка, контрольная сумма.
/// Один шаг на всё это, потому что ядро отдаёт исход целиком, а не по частям.
pub const BACKUP_STEP_ARCHIVE: &str = "archive";
pub const BACKUP_STEP_DOWNLOAD: &str = "download";
/// Уборка архива на сервере — после выгрузки, чем бы она ни кончилась.
pub const BACKUP_STEP_REMOTE_CLEANUP: &str = "remote_cleanup";
/// Пересъёмка снимка домена, чтобы успех стал виден на экране.
pub const BACKUP_STEP_FACTS: &str = "facts";
/// Пересъёмка не удалась. Сам бэкап при этом УДАЛСЯ — см. `facts_refreshed`.
pub const BACKUP_STEP_FACTS_FAILED: &str = "facts_failed";

/// Строка-маркер «прогон отменён человеком», по которой фронт отличает отмену
/// от сбоя. Тот же приём, что `HOST_KEY_UNKNOWN` в `domain_facts`: отмена — не
/// авария, и красный тост на неё был бы враньём.
pub const BACKUP_CANCELLED_SENTINEL: &str = "BACKUP_CANCELLED";

/// Через сколько молчания сервера считаем сессию бэкапа оборванной.
///
/// Внимание: это НЕ сумма exec-бюджетов, как у `FACTS_SESSION_TIMEOUT`, и это
/// осознанно. Сумма здесь — часы (`BACKUP_ARCHIVE_TIMEOUT` × число баз плюс
/// упаковка), а inactivity в часы означает «перестать замечать оборванную
/// связь вовсе». Молчание живой сессии заполняет keepalive (`KEEPALIVE_INTERVAL`
/// в `ssh::client`), и inactivity сбрасывается ответом на него, поэтому долгий
/// молчаливый `tar` эту сессию не убивает. От порога требуется одно: пережить
/// весь keepalive-бюджет, чтобы у russh остался запас на пропущенный ответ.
/// Соотношение закреплено тестом ниже.
const BACKUP_SESSION_TIMEOUT: Duration = Duration::from_secs(300);

/// Сколько тишины В ПОТОКЕ выгрузки терпим. Меряется именно тишина, а не
/// длительность (`exec_to_writer`), поэтому гигабайтная выгрузка не обрывается
/// сама собой, а вставший сервер ловится за две минуты.
const BACKUP_DOWNLOAD_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Не чаще этого шлём события прогресса выгрузки.
///
/// Чанк у `exec_to_writer` ≤ 32 KiB, то есть ~32 тысячи событий на гигабайт.
/// Без троттлинга это не «много событий», а очередь IPC, в которой вебвью
/// захлебнётся раньше, чем докачается файл.
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(250);
/// Второй порог — по объёму: на быстром канале 250 мс это уже десятки мегабайт,
/// и без него полоса дёргалась бы редкими скачками.
const PROGRESS_MIN_BYTES: u64 = 4 * 1024 * 1024;

/// Что уехало наружу после удачного бэкапа.
///
/// Поля `output` здесь нет, и это то же правило, что у `CreateSiteResult`: нет
/// поля — нет пути утечки. Сырой вывод команд сервера в структуру, которую
/// команда отдаёт в вебвью, не кладётся вовсе.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct BackupResult {
    pub file_name: String,
    /// Куда лёг файл НА МАШИНЕ ПОЛЬЗОВАТЕЛЯ.
    ///
    /// Наружу (во фронт) — да: фаза 7 обязана печатать путь, который вернула
    /// команда, а не тот, что выбрал человек (это разные вещи, если панель
    /// сохранения дописала расширение). На СЕРВЕР — никогда: см. аудит ниже.
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub parts: Vec<BackupPart>,
    /// Что прошло, но не идеально.
    ///
    /// Тип — `Vec<String>`, а не `Vec<&'static str>` из плана, и это решение, а
    /// не недосмотр. Ядро (`backup_run`, отступление 5 фазы 2) собирает
    /// предупреждения с цифрами: каким кодом кончился `tar`, какого инструмента
    /// нет, какой путь остался на сервере. Статическая строка этого выразить не
    /// может, а «tar вернул код» без кода — не предупреждение, а намёк.
    ///
    /// Правило «нет поля — нет пути утечки» при этом не нарушено, потому что
    /// оно про другое: оно запрещает СЫРОЙ вывод команд (там эхо argv, а в argv
    /// FastPanel — сгенерированные пароли). Здесь строки собраны нами из
    /// классифицированных исходов, пароля в них нет по построению (ядро не
    /// кладёт пароль БД в argv вовсе), и наружу они идут только в вебвью — на
    /// ту же машину. В аудит на сервер уходят ЧИСЛА, а не эти строки.
    pub warnings: Vec<String>,
    pub duration_ms: u64,
    /// Удалось ли пересъёмом фактов обновить снимок домена.
    ///
    /// Отдельное поле, потому что провал пересъёмки не делает бэкап неудачным:
    /// архив уже лежит на диске. Но и промолчать нельзя — экран остался со
    /// старым снимком, и сказать об этом надо словами, а не тишиной.
    pub facts_refreshed: bool,
}

// ---- второй слой идемпотентности: реестр прогонов ---------------------------

/// Идущие прогоны бэкапа: домен → флаг отмены.
///
/// `Arc` внутрь взят не ради многопоточности (managed state и так общий), а
/// ради [`BackupRunGuard`]: сторож обязан пережить `State<'_, …>` с его
/// лизнью, чтобы снимать регистрацию в `Drop` — то есть на ЛЮБОМ пути выхода
/// команды, включая ранний `?`, панику и брошенный фьючер.
#[derive(Default)]
pub struct BackupRuns(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

impl BackupRuns {
    /// Занять домен под прогон. Второй раз по тому же домену — отказ.
    pub fn start(&self, domain_id: &str) -> Result<BackupRunGuard, CommandError> {
        let mut map = self
            .0
            .lock()
            .map_err(|e| CommandError::Api(format!("backup runs: {e}")))?;
        if map.contains_key(domain_id) {
            return Err(CommandError::Api(
                "a backup for this domain is already running in this desktop".into(),
            ));
        }
        let cancel = Arc::new(AtomicBool::new(false));
        map.insert(domain_id.to_string(), cancel.clone());
        Ok(BackupRunGuard {
            runs: self.0.clone(),
            domain_id: domain_id.to_string(),
            cancel,
        })
    }

    /// Попросить прогон остановиться. `false` — такого прогона нет.
    ///
    /// Именно «попросить»: флаг читается в `on_progress` выгрузки (реакция
    /// мгновенная) и между шагами (реакция на границе команды). Уже идущий
    /// часовой `tar` на сервере этим не прерывается — прерывается наше
    /// ожидание его, а мусор за собой убирает ядро.
    pub fn cancel(&self, domain_id: &str) -> bool {
        match self.0.lock() {
            Ok(map) => match map.get(domain_id) {
                Some(flag) => {
                    flag.store(true, Ordering::SeqCst);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }
}

/// Регистрация прогона, снимающаяся в `Drop`.
///
/// Именно `Drop`, а не явное снятие в конце команды: у команды девять путей
/// выхода (каждый `?` — свой), и снятие, написанное руками, рано или поздно
/// забудут на одном из них. Забытая регистрация означает домен, который больше
/// никогда не даст сделать бэкап до перезапуска приложения.
pub struct BackupRunGuard {
    runs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    domain_id: String,
    cancel: Arc<AtomicBool>,
}

impl BackupRunGuard {
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

impl Drop for BackupRunGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = self.runs.lock() {
            map.remove(&self.domain_id);
        }
    }
}

// ---- отмена между шагами ----------------------------------------------------

/// Обёртка над сессией, которая перестаёт пускать команды на сервер, как только
/// прогон отменён.
///
/// Ядро `create_backup` — один вызов на девять шагов, и без этой обёртки отмена
/// во время сборки архива была бы не видна ему вовсе: нажатие «отмена» на
/// пятнадцатой минуте `tar` действовало бы только после его конца. Обёртка
/// вставляет проверку флага между шагами ядра, ничего в нём не меняя.
///
/// Отказ **одноразовый**, и это главное решение типа: сработав, обёртка
/// пропускает все следующие команды. Иначе вместе с работой мы отменили бы и
/// уборку — `rm -rf` рабочего каталога идёт через тот же `Exec`, и замок
/// остался бы на сервере, заблокировав следующий бэкап до ручного вмешательства.
pub(crate) struct CancellableExec<'a, S: Exec> {
    inner: &'a mut S,
    cancel: Arc<AtomicBool>,
    fired: bool,
}

impl<'a, S: Exec> CancellableExec<'a, S> {
    pub(crate) fn new(inner: &'a mut S, cancel: Arc<AtomicBool>) -> Self {
        CancellableExec {
            inner,
            cancel,
            fired: false,
        }
    }
}

#[async_trait]
impl<S: Exec + Send> Exec for CancellableExec<'_, S> {
    async fn run(&mut self, cmd: &str, timeout: Duration) -> Result<(i32, String), SshError> {
        if !self.fired && self.cancel.load(Ordering::SeqCst) {
            self.fired = true;
            // `Cancelled` с нулём байт — честно: этой командой не скачано
            // ничего, она вообще не ушла на сервер.
            return Err(SshError::Cancelled { bytes: 0 });
        }
        self.inner.run(cmd, timeout).await
    }
}

// ---- троттлинг событий ------------------------------------------------------

/// Решает, пора ли слать очередное событие прогресса.
///
/// Часы приходят параметром, а не берутся внутри: без этого правило проверялось
/// бы `sleep`'ами, то есть медленно и с плавающим результатом.
#[derive(Default)]
pub(crate) struct ProgressThrottle {
    last_at: Option<Instant>,
    last_bytes: u64,
}

impl ProgressThrottle {
    pub(crate) fn should_emit(&mut self, now: Instant, bytes: u64) -> bool {
        let by_time = match self.last_at {
            None => true,
            Some(t) => now.duration_since(t) >= PROGRESS_MIN_INTERVAL,
        };
        let by_bytes = bytes.saturating_sub(self.last_bytes) >= PROGRESS_MIN_BYTES;
        if by_time || by_bytes {
            self.last_at = Some(now);
            self.last_bytes = bytes;
            return true;
        }
        false
    }
}

fn emit_progress(
    app: &AppHandle,
    domain_id: &str,
    step: &str,
    done_bytes: Option<u64>,
    total_bytes: Option<u64>,
) {
    let mut payload = serde_json::json!({ "domain_id": domain_id, "step": step });
    if let Some(d) = done_bytes {
        payload["done_bytes"] = serde_json::json!(d);
    }
    // Знаменателя нет — поля нет. Полоса со знаменателем «на глаз» врала бы.
    if let Some(t) = total_bytes {
        payload["total_bytes"] = serde_json::json!(t);
    }
    let _ = app.emit(BACKUP_PROGRESS_EVENT, payload);
}

/// Отмена как ошибка команды: одна строка-маркер на все места, где она может
/// случиться.
fn cancelled_error() -> CommandError {
    CommandError::Api(BACKUP_CANCELLED_SENTINEL.into())
}

fn is_cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

/// Ошибка ядра → ошибка команды. Отмена, доехавшая сквозь ядро (её приносит
/// [`CancellableExec`]), опознаётся здесь и наружу идёт маркером, а не текстом
/// про оборванный поток.
fn backup_error_to_command(e: crate::ssh::backup_run::BackupError) -> CommandError {
    if let crate::ssh::backup_run::BackupError::Ssh(SshError::Cancelled { .. }) = e {
        return cancelled_error();
    }
    CommandError::Ssh(e.to_string())
}

/// Ошибка выгрузки → ошибка команды.
///
/// Отмена уходит маркером — на экране это не авария. Настоящий сбой уносит с
/// собой путь архива, оставшегося на сервере: мы его не удалили намеренно (см.
/// [`should_remove_remote_archive`]), и промолчать об этом значит оставить
/// гигабайт на чужой машине без единого слова.
fn download_failure_to_command(e: DownloadError, remote_path: &str) -> CommandError {
    if e.is_cancelled() {
        return cancelled_error();
    }
    CommandError::Ssh(format!(
        "{e}. The archive itself is still on the server at {remote_path} — SDMP did not remove it, \
         because after a failed download that is the only complete copy left; \
         remove it by hand once you no longer need it"
    ))
}

// ---- уборка архива на сервере ----------------------------------------------

/// Сносить ли архив на сервере по итогу выгрузки.
///
/// Правило одно: удаляем то, что больше не нужно. Успех — файл у человека на
/// диске, проверен по хешу и размеру и уже переименован из `.part` (только
/// после этого [`backup_download::download_archive`] отдаёт `Ok`, так что
/// «после переименования» здесь гарантировано типом). Отмена — человек сказал,
/// что файл ему не нужен, а мусор за собой оставлять нельзя.
///
/// Провал выгрузки — единственный случай, когда оставляем: на сервере тогда
/// лежит ЕДИНСТВЕННАЯ целая копия (у нас-то `.part` уже снесён сторожем), и
/// снести её значит выбросить час работы `tar` из-за оборвавшейся сети.
pub(crate) fn should_remove_remote_archive(
    outcome: Result<&backup_download::DownloadOutcome, &DownloadError>,
) -> bool {
    match outcome {
        Ok(_) => true,
        Err(e) => e.is_cancelled(),
    }
}

/// Команда удаления архива — или `None`, если путь не наш.
///
/// Проверка пути здесь не паранойя, а цена ошибки: строка приезжает из ядра, а
/// исполняется как `rm` под root на чужом продакшне. Удаляем только то, что
/// сами и создали, — файл НЕПОСРЕДСТВЕННО в [`BACKUP_WORK_ROOT`], без глобов,
/// с `q()` на пути. Каталог (`rm -rf`) здесь не наш случай вовсе: рабочий
/// каталог сносит ядро.
pub(crate) fn build_remote_archive_rm_cmd(path: &str) -> Option<String> {
    let prefix = format!("{BACKUP_WORK_ROOT}/");
    let rest = path.strip_prefix(&prefix)?;
    // Ни пусто, ни вложенный путь, ни `.`/`..`: имя файла и только оно.
    if rest.is_empty() || rest.contains('/') || rest == "." || rest == ".." {
        return None;
    }
    Some(format!("rm -f {}", q(path)))
}

// ---- сами команды -----------------------------------------------------------

/// Сделать архив домена на сервере и скачать его в `dest_path`.
///
/// Возвращает [`BackupResult`]; путь назначения проверяется ДО keychain и SSH —
/// баг фронта дешевле поймать до часа работы `tar` на продакшне, чем после.
#[tauri::command]
pub async fn domain_backup_create(
    app: AppHandle,
    user_id: String,
    domain_id: String,
    dest_path: String,
    handle: State<'_, SyncHandle>,
    api: State<'_, ApiClient>,
    runs: State<'_, BackupRuns>,
) -> Result<BackupResult, CommandError> {
    let started = Instant::now();
    let dest =
        backup_download::validate_dest_path(&dest_path).map_err(|e| CommandError::Api(e.to_string()))?;

    // Второй слой идемпотентности. Сторож снимет регистрацию в `Drop` — на
    // любом пути выхода ниже.
    let run = runs.start(&domain_id)?;
    let cancel = run.cancel_flag();

    let mut key = keychain::load_vault_key(&user_id)
        .map_err(|e| CommandError::Keychain(e.to_string()))?
        .ok_or_else(|| CommandError::Keychain("locked".into()))?;
    let path = cache_path(&handle)?;
    let conn = cache::open(&path, &key).map_err(|e| CommandError::Api(e.to_string()))?;

    let domain_row = cache::get_row_fields(&conn, "domains", &domain_id)
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
    let password = blob_plaintext(&api, &key, &blob_id).await;
    // Ключ хранилища дальше не нужен: только SSH и HTTP. Гасим до разбора
    // результата, как в `domain_facts`.
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

    let domain_name = domain_row
        .get("domain_name")
        .and_then(json_str)
        .ok_or_else(|| CommandError::Api("domain missing domain_name".into()))?;
    let site_user = domain_row.get("site_user").and_then(json_str);

    let device_id = cache::get_meta(&conn, "device_id")
        .map_err(|e| CommandError::Api(e.to_string()))?
        .and_then(|s| Uuid::parse_str(&s).ok());
    // Всё нужное забрали — держать SQLCipher открытым весь бэкап незачем.
    drop(conn);

    emit_progress(&app, &domain_id, BACKUP_STEP_CONNECT, None, None);
    let session = ssh_connect_session_with_timeout(
        &app,
        &host,
        port,
        &ssh_user,
        &password,
        BACKUP_SESSION_TIMEOUT,
    )
    .await;
    // Пароль сервера дальше не нужен ни на успешном пути, ни на ошибочном.
    password.zeroize();
    let mut session = session?;

    let outcome = run_backup(
        &app,
        &mut session,
        &domain_id,
        &domain_name,
        site_user.as_deref(),
        &dest,
        &cancel,
        &api,
        started,
    )
    .await;
    let _ = session.disconnect().await;

    // Аудит — после закрытия сессии и только на успехе: неудавшийся бэкап
    // ничего на машине пользователя не создал, записывать нечего.
    if let Ok(ref result) = outcome {
        // Метаданные без секретов И БЕЗ ПУТИ НАЗНАЧЕНИЯ. Путь — локальная ФС
        // пользователя, и `~/Documents/клиент-X/` сам по себе разглашение: по
        // нему видно, чей это домен, даже если больше не видно ничего.
        // Имени файла тоже нет — оно содержит домен, а домен уже в `target_id`.
        //
        // Числа, а не имена: на вопрос «что попало в архив» отвечает счётчик
        // частей и счётчик баз, а имена баз ничего к ответу не добавляют —
        // зато уезжают на сервер, которому мы по построению не рассказываем
        // больше необходимого. Предупреждения сюда не идут по той же причине:
        // в них бывает путь на сервере и хвост чужого stderr.
        audit_best_effort(
            &app,
            &api,
            "domain.backup_created",
            "domain",
            &domain_id,
            device_id,
            Some(serde_json::json!({
                "bytes": result.bytes,
                "parts": result.parts.len(),
                "duration_ms": result.duration_ms,
                "databases": result
                    .parts
                    .iter()
                    .filter(|p| p.kind == "database")
                    .count(),
            })),
        )
        .await;
    }

    outcome
}

/// Отменить идущий прогон бэкапа домена.
///
/// `false` — прогона нет (уже кончился или его не было). Это не ошибка: кнопку
/// отмены могли нажать в тот же миг, когда выгрузка закончилась.
#[tauri::command]
pub async fn domain_backup_cancel(
    domain_id: String,
    runs: State<'_, BackupRuns>,
) -> Result<bool, CommandError> {
    Ok(runs.cancel(&domain_id))
}

/// Работа внутри уже открытой сессии.
///
/// Вынесено ровно затем же, зачем `run_provision_steps`: вызывающий закрывает
/// сессию один раз на любом пути выхода, и каждый `?` здесь иначе утекал бы
/// соединением.
#[allow(clippy::too_many_arguments)]
async fn run_backup(
    app: &AppHandle,
    session: &mut crate::ssh::client::SshSession,
    domain_id: &str,
    domain_name: &str,
    site_user: Option<&str>,
    dest: &Path,
    cancel: &Arc<AtomicBool>,
    api: &ApiClient,
    started: Instant,
) -> Result<BackupResult, CommandError> {
    if is_cancelled(cancel) {
        return Err(cancelled_error());
    }

    // Бинарь панели ищем как везде. Без него архивировать нечем: пути сайта и
    // список баз знает только FastPanel.
    let fp = fastpanel::get_fastpanel_path(session, None)
        .await?
        .ok_or_else(|| CommandError::Api("fastpanel is not installed on the server".into()))?;

    emit_progress(app, domain_id, BACKUP_STEP_ARCHIVE, None, None);
    let artifact = {
        // Обёртка живёт ровно столько, сколько идёт сборка: дальше сессия
        // нужна нам самим (выгрузка, уборка, факты), и отменять эти шаги
        // обёрткой было бы неверно — уборку отменять нельзя.
        let mut ex = CancellableExec::new(session, cancel.clone());
        create_backup(&mut ex, &fp, domain_name, Utc::now())
            .await
            .map_err(backup_error_to_command)?
    };
    let mut warnings = artifact.warnings.clone();

    // Выгрузка. Отмена читается в `on_progress`, то есть после каждого чанка.
    let total = artifact.bytes;
    let seen = Arc::new(AtomicU64::new(0));
    emit_progress(
        app,
        domain_id,
        BACKUP_STEP_DOWNLOAD,
        Some(0),
        Some(total),
    );
    let download = {
        let app_c = app.clone();
        let did = domain_id.to_string();
        let flag = cancel.clone();
        let seen_c = seen.clone();
        let mut throttle = ProgressThrottle::default();
        backup_download::download_archive(
            session,
            &artifact.path,
            dest,
            &artifact.sha256,
            artifact.bytes,
            BACKUP_DOWNLOAD_IDLE_TIMEOUT,
            move |done| {
                seen_c.store(done, Ordering::SeqCst);
                if flag.load(Ordering::SeqCst) {
                    return ControlFlow::Break(());
                }
                if throttle.should_emit(Instant::now(), done) {
                    emit_progress(
                        &app_c,
                        &did,
                        BACKUP_STEP_DOWNLOAD,
                        Some(done),
                        Some(total),
                    );
                }
                ControlFlow::Continue(())
            },
        )
        .await
    };
    // Последнее событие шага — ВСЕГДА, чем бы шаг ни кончился: иначе на экране
    // навсегда осталось бы предпоследнее значение троттлинга, то есть цифра,
    // которой прогон не кончался.
    emit_progress(
        app,
        domain_id,
        BACKUP_STEP_DOWNLOAD,
        Some(seen.load(Ordering::SeqCst)),
        Some(total),
    );

    // Архив на сервере — наш мусор, и убрать его обязаны мы: ядро на успехе
    // сносит рабочий каталог, но сам `<домен>-<штамп>.tar` оставляет лежать в
    // `/var/tmp/sdmp-backup/` (его доктрина кончается словами «архив лежит на
    // сервере, вот путь»). Не убери его никто — продакшн, обслуживающий живые
    // сайты, забьётся многогигабайтными тарболлами.
    //
    // Решает [`should_remove_remote_archive`]: сносим, когда файл больше не
    // нужен (успех — копия у человека проверена и переименована; отмена —
    // человек передумал), и ОСТАВЛЯЕМ, когда выгрузка не удалась. Второе не
    // забывчивость: при обрыве или несовпадении хеша единственная целая копия
    // — как раз та, что на сервере, и снести её значит выбросить час работы
    // `tar`, который человек ещё может спасти руками. Тогда путь называется в
    // тексте ошибки.
    let remove_remote = should_remove_remote_archive(download.as_ref());
    if remove_remote {
        emit_progress(app, domain_id, BACKUP_STEP_REMOTE_CLEANUP, None, None);
        match build_remote_archive_rm_cmd(&artifact.path) {
            Some(cmd) => match session.run(&cmd, BACKUP_STEP_TIMEOUT).await {
                Ok((0, _)) => {}
                // Не роняем удавшийся бэкап из-за неубранного архива, но и не
                // молчим: место на диске сервера кончится молча, а тут
                // написано, где именно лежит гигабайт.
                Ok((code, _)) => warnings.push(format!(
                    "the archive is still on the server at {} (rm exited {code}) — remove it by hand",
                    artifact.path
                )),
                Err(e) => warnings.push(format!(
                    "the archive is still on the server at {} ({e}) — remove it by hand",
                    artifact.path
                )),
            },
            // Путь, не похожий на наш собственный, мы не удаляем вовсе: `rm` по
            // строке, пришедшей не оттуда, откуда мы думаем, — это не уборка.
            None => warnings.push(format!(
                "refused to remove {} on the server: it is not a path SDMP created",
                artifact.path
            )),
        }
    }

    let saved = match download {
        Ok(saved) => saved,
        Err(e) => return Err(download_failure_to_command(e, &artifact.path)),
    };
    let duration_ms = started.elapsed().as_millis() as u64;

    // Пересъёмка снимка: список копий приезжает из `fp_facts`, и без неё экран
    // после удачного бэкапа выглядел бы ровно как до него.
    //
    // Провал пересъёмки НЕ делает бэкап неудачным — архив уже на диске, и `?`
    // здесь заставил бы человека гонять гигабайты второй раз из-за сетевого
    // сбоя на последнем шаге. Но и молчать нельзя: событие + поле
    // `facts_refreshed` говорят, что снимок остался старым.
    //
    // Провал НЕ записывается на сервер телом `{error}` (в отличие от
    // `domain_read_facts`) сознательно: `fp_check_error` — сигнал здоровья
    // самого домена, а здесь чтение было нашей попутной услугой, о которой
    // человек не просил. Запись отодвинула бы `fp_checked_at` и объявила
    // домен непрочитанным по итогам действия, которое удалось.
    emit_progress(app, domain_id, BACKUP_STEP_FACTS, None, None);
    let facts_refreshed =
        refresh_facts(session, api, domain_id, domain_name, site_user, &fp).await;
    if !facts_refreshed {
        emit_progress(app, domain_id, BACKUP_STEP_FACTS_FAILED, None, None);
    }

    Ok(BackupResult {
        file_name: artifact.file_name,
        path: dest.to_string_lossy().to_string(),
        bytes: saved.bytes,
        sha256: saved.sha256,
        parts: artifact.parts,
        warnings,
        duration_ms,
        facts_refreshed,
    })
}

/// Пересъёмка снимка домена + write-back. Best-effort целиком: `true` — снимок
/// на сервере обновлён, `false` — что-то из двух не вышло.
async fn refresh_facts(
    session: &mut crate::ssh::client::SshSession,
    api: &ApiClient,
    domain_id: &str,
    domain_name: &str,
    site_user: Option<&str>,
    fp: &str,
) -> bool {
    let facts = match fastpanel_facts::read_domain_facts(session, fp, domain_name, site_user).await
    {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(target: "backup", "re-reading domain facts after a backup failed: {e}");
            return false;
        }
    };
    let value = match serde_json::to_value(&facts) {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!(target: "backup", "serializing domain facts failed: {e}");
            return false;
        }
    };
    let body = serde_json::json!({ "facts": value });
    if let Err(e) = api.domain_facts_write_back(domain_id, &body).await {
        tracing::warn!(target: "backup", "write-back of domain facts after a backup failed: {e}");
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::client::{KEEPALIVE_BUDGET, KEEPALIVE_INTERVAL};

    // Порог тишины сессии обязан пережить весь keepalive-бюджет: поставленный
    // ниже, он убил бы сессию раньше, чем russh израсходует свои попытки, и
    // молчащий часовой `tar` обрывался бы ровно так же, как до keepalive.
    //
    // Сумму exec-бюджетов (как в `domain_facts`) здесь проверять НЕЛЬЗЯ: она
    // равна часам, и порог в часы означал бы «не замечать обрыва вовсе».
    #[test]
    fn session_timeout_outlives_the_keepalive_budget() {
        assert!(
            BACKUP_SESSION_TIMEOUT > KEEPALIVE_BUDGET,
            "session {BACKUP_SESSION_TIMEOUT:?} must exceed keepalive budget {KEEPALIVE_BUDGET:?}"
        );
        assert!(BACKUP_SESSION_TIMEOUT > KEEPALIVE_INTERVAL);
    }

    // Тишина в потоке выгрузки ловится раньше, чем умрёт сессия: иначе вместо
    // внятного «сервер молчит» мы получали бы оборванный канал, у которого
    // stderr уже потерян.
    #[test]
    fn the_download_gives_up_on_silence_before_the_session_does() {
        assert!(BACKUP_DOWNLOAD_IDLE_TIMEOUT < BACKUP_SESSION_TIMEOUT);
    }

    // ---- реестр прогонов ----------------------------------------------------

    #[test]
    fn a_second_run_on_the_same_domain_is_refused() {
        let runs = BackupRuns::default();
        let _first = runs.start("d1").expect("первый прогон");
        assert!(runs.start("d1").is_err(), "второй прогон обязан быть отказан");
        // Другой домен — другой прогон, они друг другу не мешают.
        assert!(runs.start("d2").is_ok());
    }

    #[test]
    fn the_slot_is_released_when_the_guard_dies() {
        let runs = BackupRuns::default();
        {
            let _g = runs.start("d1").unwrap();
            assert!(runs.start("d1").is_err());
        }
        assert!(runs.start("d1").is_ok(), "слот не освободился после Drop");
    }

    // Путь выхода, о котором забывают чаще всего: паника посреди прогона.
    // Без `Drop` домен остался бы занятым до перезапуска приложения.
    #[test]
    fn the_slot_is_released_even_when_the_run_panics() {
        let runs = BackupRuns::default();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = runs.start("d1").unwrap();
            panic!("boom");
        }));
        assert!(r.is_err());
        assert!(runs.start("d1").is_ok(), "слот не освободился после паники");
    }

    // Ранний выход по `?`: guard создан, дальше ошибка — слот обязан
    // освободиться сам. Разыгрываем ровно ту форму, что у команды.
    #[test]
    fn the_slot_is_released_on_an_early_error_return() {
        let runs = BackupRuns::default();
        fn fails(runs: &BackupRuns) -> Result<(), CommandError> {
            let _g = runs.start("d1")?;
            Err(CommandError::Api("cache is not initialized".into()))
        }
        assert!(fails(&runs).is_err());
        assert!(runs.start("d1").is_ok());
    }

    #[test]
    fn cancel_flips_the_flag_of_that_domain_only() {
        let runs = BackupRuns::default();
        let g1 = runs.start("d1").unwrap();
        let g2 = runs.start("d2").unwrap();
        assert!(runs.cancel("d1"));
        assert!(g1.cancel_flag().load(Ordering::SeqCst));
        assert!(!g2.cancel_flag().load(Ordering::SeqCst));
        // Прогона нет — не ошибка, а `false`: кнопку могли нажать в тот же миг,
        // когда выгрузка закончилась.
        assert!(!runs.cancel("d-unknown"));
    }

    #[test]
    fn cancelling_a_finished_run_does_nothing() {
        let runs = BackupRuns::default();
        drop(runs.start("d1").unwrap());
        assert!(!runs.cancel("d1"));
    }

    // ---- отмена между шагами ядра -------------------------------------------

    struct CountingExec {
        seen: Vec<String>,
    }

    #[async_trait]
    impl Exec for CountingExec {
        async fn run(&mut self, cmd: &str, _t: Duration) -> Result<(i32, String), SshError> {
            self.seen.push(cmd.to_string());
            Ok((0, String::new()))
        }
    }

    #[tokio::test]
    async fn commands_stop_reaching_the_server_once_the_run_is_cancelled() {
        let mut inner = CountingExec { seen: Vec::new() };
        let flag = Arc::new(AtomicBool::new(false));
        {
            let mut ex = CancellableExec::new(&mut inner, flag.clone());
            ex.run("first", Duration::from_secs(1)).await.unwrap();
            flag.store(true, Ordering::SeqCst);
            let err = ex.run("second", Duration::from_secs(1)).await.unwrap_err();
            assert!(matches!(err, SshError::Cancelled { .. }), "{err}");
        }
        assert_eq!(inner.seen, vec!["first".to_string()]);
    }

    // Одноразовость отказа — не мелочь: `rm -rf` рабочего каталога идёт через
    // тот же `Exec` сразу после отказа, и запрети мы и его, замок остался бы на
    // сервере, заблокировав следующий бэкап до ручного вмешательства.
    #[tokio::test]
    async fn the_cleanup_right_after_a_cancellation_still_reaches_the_server() {
        let mut inner = CountingExec { seen: Vec::new() };
        let flag = Arc::new(AtomicBool::new(true));
        {
            let mut ex = CancellableExec::new(&mut inner, flag);
            assert!(ex.run("tar ...", Duration::from_secs(1)).await.is_err());
            ex.run("rm -rf /var/tmp/sdmp-backup/example.com", Duration::from_secs(1))
                .await
                .expect("уборка обязана пройти");
        }
        assert_eq!(inner.seen.len(), 1);
        assert!(inner.seen[0].starts_with("rm -rf"), "{:?}", inner.seen);
    }

    // Отмена, доехавшая сквозь ядро, обязана прийти во фронт маркером, а не
    // текстом про оборванный поток: на экране это разные слова.
    #[test]
    fn a_cancelled_core_run_surfaces_as_the_cancellation_marker() {
        let e = backup_error_to_command(crate::ssh::backup_run::BackupError::Ssh(
            SshError::Cancelled { bytes: 0 },
        ));
        assert!(matches!(e, CommandError::Api(ref m) if m == BACKUP_CANCELLED_SENTINEL), "{e}");

        let e = download_failure_to_command(
            DownloadError::Ssh(SshError::Cancelled { bytes: 7 }),
            "/var/tmp/sdmp-backup/example.com-20260819T103000Z.tar",
        );
        assert!(matches!(e, CommandError::Api(ref m) if m == BACKUP_CANCELLED_SENTINEL), "{e}");
    }

    // А настоящий сбой маркером притворяться не должен — иначе отменой
    // выглядел бы битый архив.
    #[test]
    fn a_real_failure_is_not_dressed_up_as_a_cancellation() {
        let e = download_failure_to_command(
            DownloadError::SizeMismatch {
                expected: 10,
                got: 9,
            },
            "/var/tmp/sdmp-backup/example.com-20260819T103000Z.tar",
        );
        assert!(!format!("{e}").contains(BACKUP_CANCELLED_SENTINEL), "{e}");
        // И путь оставшегося на сервере архива назван — иначе гигабайт остался
        // бы там молча.
        assert!(
            format!("{e}").contains("/var/tmp/sdmp-backup/example.com-20260819T103000Z.tar"),
            "{e}"
        );

        let e = backup_error_to_command(crate::ssh::backup_run::BackupError::LockHeld {
            path: "/var/tmp/sdmp-backup/example.com".into(),
            state: "held for 3 minutes".into(),
        });
        assert!(!format!("{e}").contains(BACKUP_CANCELLED_SENTINEL), "{e}");
        // Действенный текст ядра доезжает наружу целиком: в нём путь и что с
        // ним делать.
        assert!(format!("{e}").contains("/var/tmp/sdmp-backup/example.com"), "{e}");
    }

    // ---- уборка архива на сервере -------------------------------------------

    // Главное правило: снос — только когда файл у человека проверен и уже
    // переименован. `Ok` от `download_archive` этому и равен по построению:
    // раньше переименования он не возвращается.
    #[test]
    fn the_remote_archive_goes_only_after_the_local_copy_is_proven() {
        let ok = backup_download::DownloadOutcome {
            bytes: 10,
            sha256: "aa".into(),
        };
        assert!(should_remove_remote_archive(Ok(&ok)));
    }

    // Не подтвердилась целостность — не удаляем: на сервере тогда единственная
    // целая копия, а `.part` у нас уже снесён сторожем.
    #[test]
    fn a_download_that_failed_leaves_the_remote_archive_where_it_is() {
        for e in [
            DownloadError::ChecksumMismatch {
                expected: "aa".into(),
                got: "bb".into(),
            },
            DownloadError::SizeMismatch {
                expected: 10,
                got: 9,
            },
            DownloadError::Ssh(SshError::Disconnected { bytes: 5 }),
            DownloadError::RemoteFailed {
                exit: 1,
                signal: String::new(),
                stderr: "no such file".into(),
            },
        ] {
            assert!(
                !should_remove_remote_archive(Err(&e)),
                "нельзя сносить после {e}"
            );
        }
    }

    // Отмена — другое дело: человек сказал, что файл ему не нужен, и оставлять
    // за собой гигабайт на чужом продакшне нельзя.
    #[test]
    fn a_cancelled_download_takes_the_remote_archive_with_it() {
        let e = DownloadError::Ssh(SshError::Cancelled { bytes: 5 });
        assert!(should_remove_remote_archive(Err(&e)));
    }

    // `rm` под root на чужой машине — команда, у которой цена ошибки не
    // «неудобно», а «сервер». Удаляем только файл непосредственно в нашем
    // рабочем корне и только через `q()`.
    #[test]
    fn only_a_file_we_created_ourselves_can_be_removed() {
        let good = format!("{BACKUP_WORK_ROOT}/example.com-20260819T103000Z.tar");
        let cmd = build_remote_archive_rm_cmd(&good).expect("наш путь");
        assert!(cmd.starts_with("rm -f "), "{cmd}");
        assert!(cmd.contains(&good), "{cmd}");
        // Ни глобов, ни `-r`: каталоги сносит ядро, а не мы.
        assert!(!cmd.contains('*'), "{cmd}");
        assert!(!cmd.contains("-r"), "{cmd}");

        for bad in [
            "",
            "/",
            "/etc/passwd",
            BACKUP_WORK_ROOT,
            &format!("{BACKUP_WORK_ROOT}/"),
            &format!("{BACKUP_WORK_ROOT}/.."),
            &format!("{BACKUP_WORK_ROOT}/sub/dir.tar"),
            "example.com.tar",
        ] {
            assert!(
                build_remote_archive_rm_cmd(bad).is_none(),
                "путь {bad:?} не должен удаляться"
            );
        }
    }

    // Имя с кавычкой в шелле — через `q()`, как всё в этом продукте.
    #[test]
    fn a_hostile_file_name_still_goes_through_the_shell_quoter() {
        let path = format!("{BACKUP_WORK_ROOT}/a b'c-20260819T103000Z.tar");
        let cmd = build_remote_archive_rm_cmd(&path).expect("наш путь");
        // Одинарные кавычки сбалансированы (экранированные `\'` не в счёт) — то
        // есть строка прошла через `q()`, а не склеена руками. Приём взят из
        // тестов `backup_run`, где им проверяются все интерполяции ядра.
        let chars: Vec<char> = cmd.chars().collect();
        let n = chars
            .iter()
            .enumerate()
            .filter(|(i, c)| **c == '\'' && (*i == 0 || chars[i - 1] != '\\'))
            .count();
        assert_eq!(n % 2, 0, "кавычки не сбалансированы: {cmd}");
        // Апостроф в имени не закрыл аргумент: за ним идёт экранирование, а не
        // конец строки и начало новой команды.
        assert!(!cmd.contains("a b'c-"), "апостроф не экранирован: {cmd}");
        assert!(cmd.contains("a b"), "{cmd}");
    }

    // ---- троттлинг ----------------------------------------------------------

    // 32 KiB чанки без троттлинга — ~32 тысячи событий на гигабайт. Порог по
    // объёму обязан схлопнуть их в единицы.
    #[test]
    fn thirty_two_kib_chunks_do_not_become_thirty_two_thousand_events() {
        let mut t = ProgressThrottle::default();
        let now = Instant::now();
        let mut emitted = 0;
        let mut done = 0u64;
        for _ in 0..1024 {
            done += 32 * 1024; // ровно 32 MiB суммарно
            if t.should_emit(now, done) {
                emitted += 1;
            }
        }
        // Первое событие + по одному на каждые 4 MiB.
        // Первое событие + по одному на каждые 4 MiB после него.
        assert_eq!(emitted, 8, "событий {emitted}");
        assert!(emitted < 20, "троттлинг не сработал: {emitted}");
    }

    // Медленный канал: объёма не набирается, но линия жизни нужна — её даёт
    // порог по времени.
    #[test]
    fn a_slow_stream_still_reports_by_time() {
        let mut t = ProgressThrottle::default();
        let t0 = Instant::now();
        assert!(t.should_emit(t0, 1024), "первое событие обязано пройти");
        assert!(!t.should_emit(t0 + Duration::from_millis(100), 2048));
        assert!(t.should_emit(t0 + Duration::from_millis(260), 3072));
    }

    #[test]
    fn a_burst_inside_one_tick_is_reported_by_volume() {
        let mut t = ProgressThrottle::default();
        let t0 = Instant::now();
        assert!(t.should_emit(t0, 0));
        // Те же часы, но проехало 4 MiB — порог по объёму.
        assert!(!t.should_emit(t0, PROGRESS_MIN_BYTES - 1));
        assert!(t.should_emit(t0, PROGRESS_MIN_BYTES));
    }
}
