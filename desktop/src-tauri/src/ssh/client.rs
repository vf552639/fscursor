//! SSH client (russh) with strict host-key checking and TOFU support.

use std::io::{self, Write};
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use fs2::FileExt;
use russh::client::{self, Handler};
use russh::keys::key;
use russh::ChannelMsg;
use tokio::io::AsyncWriteExt;
use tokio::time::Duration;
use zeroize::Zeroize;

/// Errors surfaced to callers (Tauri, provisioning).
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("connect: {0}")]
    Connect(String),
    /// Сервер дошёл до аутентификации и отказал.
    ///
    /// Текст называет `user@host:port` намеренно: без него на экране остаётся
    /// «auth failed», по которому нельзя отличить «пароль не тот» от «логин не
    /// тот» — а логин у нас берётся из поля сервера с молчаливым дефолтом
    /// `root`, и именно он чаще всего и не тот. Пароль, разумеется, не
    /// упоминается ничем, кроме факта, что он был.
    ///
    /// Вторая подсказка — про `PasswordAuthentication`: у образов, где парольный
    /// вход выключен, отказ выглядит ровно так же, и без этой строки человек
    /// будет перебирать пароли на сервере, который их вообще не принимает.
    #[error(
        "auth failed for {user}@{host}:{port} — the server rejected the saved password. \
         Check the SSH user (it defaults to root) and re-enter the password; \
         if the server has PasswordAuthentication disabled, no password will ever work."
    )]
    Auth {
        user: String,
        host: String,
        port: u16,
    },
    #[error("host key mismatch")]
    HostKeyMismatch,
    #[error("host key unknown — approve fingerprint in UI: {fingerprint}")]
    HostKeyUnknown { fingerprint: String },
    #[error("io: {0}")]
    Io(#[from] io::Error),
    /// Выгрузку остановил сам вызывающий (`ControlFlow::Break` из `on_progress`).
    ///
    /// Отдельный вариант, а не `Session(...)`, потому что отмена — не сбой:
    /// связь цела, сервер жив, файл просто не нужен. В аудите и на экране это
    /// обязано выглядеть иначе, чем оборванный канал, иначе человек пойдёт
    /// чинить сеть после того, как сам же нажал «отмена».
    #[error("cancelled by the caller after {bytes} bytes — the transfer was stopped on purpose, the connection is fine")]
    Cancelled { bytes: u64 },
    /// Канал кончился, не сообщив, чем кончилась команда.
    ///
    /// Третий исход рядом с отменой и простоем, и путать их нельзя: простой —
    /// «сервер молчит дольше, чем мы согласны ждать», отмена — «мы сами
    /// передумали», а это — «связь оборвалась на середине». Именно так
    /// выглядит смерть сессии по `inactivity_timeout` или по keepalive: russh
    /// роняет `Session::run`, отправитель сообщений канала исчезает, и
    /// `Channel::wait()` отдаёт `None`.
    ///
    /// Отдельный вариант появился потому, что раньше этот случай возвращался
    /// как `Ok(ExecStream { exit: -1, .. })` — то есть обрезанный на середине
    /// гигабайтный архив приезжал как штатно закрытый поток. Обрыв обязан быть
    /// ошибкой: «сколько байт успело» тут не итог, а размер потери.
    #[error(
        "connection lost after {bytes} bytes — the channel ended before the command \
         reported an exit status; whatever was written is incomplete"
    )]
    Disconnected { bytes: u64 },
    #[error("session: {0}")]
    Session(String),
}

#[derive(Debug, thiserror::Error)]
pub enum SshConnectHandlerError {
    #[error(transparent)]
    Russh(#[from] russh::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("host key mismatch")]
    HostKeyMismatch,
}

pub struct ClientHandler {
    pub known_hosts_path: PathBuf,
    pub expected_host: String,
    pub pending_unknown_fp: Arc<Mutex<Option<String>>>,
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = SshConnectHandlerError;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = server_public_key.fingerprint();
        match read_known_host(&self.known_hosts_path, &self.expected_host)? {
            Some(known) if known == fp => Ok(true),
            Some(_) => Err(SshConnectHandlerError::HostKeyMismatch),
            None => {
                *self.pending_unknown_fp.lock().expect("lock") = Some(fp);
                Ok(false)
            }
        }
    }
}

/// One line per entry: `host:port base64_fingerprint`
pub fn read_known_host(path: &Path, host_port: &str) -> io::Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(path)?;
    for raw in data.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        let host = it.next().unwrap_or("");
        let fp = it.next();
        if host == host_port {
            return Ok(fp.map(|s| s.to_string()));
        }
    }
    Ok(None)
}

pub fn append_known_host(path: &Path, host_port: &str, fingerprint: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.lock_exclusive()?;
    writeln!(f, "{} {}", host_port, fingerprint)?;
    f.unlock()?;
    Ok(())
}

/// Раз в столько тишины клиент шлёт серверу keepalive-запрос.
///
/// До этой правки keepalive был выключен вовсе: `russh::client::Config`
/// собирался с одним `inactivity_timeout`. Тот сбрасывается на любом витке
/// цикла сессии, кроме витка отправки самого keepalive (`client/mod.rs`,
/// хвост цикла `run_inner`), — но у молчащей команды витков нет вовсе, ни
/// входящих, ни исходящих. Получасовой `tar` и пятиминутный `certificates
/// create-le` не шлют ничего, и единственным способом их пережить было
/// раздувать inactivity до часов, то есть перестать замечать оборванную связь
/// вовсе. Keepalive разрывает эту связку: тишину заполняет он, а inactivity
/// остаётся сторожем настоящего обрыва.
///
/// ВНИМАНИЕ: это меняет поведение ВСЕХ SSH-операций продукта, а не только
/// бэкапов. В лучшую сторону — мёртвый сервер опознаётся за две с половиной
/// минуты (russh шлёт запросы на 30/60/90/120 с и объявляет обрыв на 150-й)
/// вместо «сколько там стоит inactivity у этого вызывающего», то есть до 600 с
/// у чтения фактов; а живая молчаливая команда перестаёт умирать от
/// собственной молчаливости. Но это изменение, и принято оно сознательно
/// (`plans/2026-08-19-bekapy-domena.md`, решение 3).
pub const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);

/// Столько неотвеченных keepalive подряд russh терпит, прежде чем объявить
/// связь мёртвой (`russh::Error::KeepaliveTimeout`).
pub const KEEPALIVE_MAX: usize = 3;

/// Сколько молчания сервера обязана переживать сессия, чтобы keepalive успел
/// израсходовать всю свою квоту попыток.
///
/// Это `KEEPALIVE_INTERVAL × (KEEPALIVE_MAX + 1)`: к этому моменту отправлены
/// все `KEEPALIVE_MAX` запросов и у последнего был целый интервал на ответ.
/// Нужна вызывающим: их `session_timeout` уходит в `inactivity_timeout`, и
/// поставленный ниже этого бюджета он убьёт сессию раньше, чем keepalive
/// доиграет свою партию — то есть запаса на пропущенный ответ не останется
/// вовсе. Связь с константами выше держит тест
/// `keepalive_budget_is_the_interval_times_every_attempt`.
pub const KEEPALIVE_BUDGET: Duration = Duration::from_secs(120);

/// Потолок буфера stderr у [`SshSession::exec_to_writer`].
///
/// Stderr гигабайтного `tar` может быть сам гигабайтным (`file changed as we
/// read it` на каждый файл), а держим мы его в памяти — в отличие от stdout,
/// который уходит в writer. 8 KiB хватает на диагностику и не хватает на то,
/// чтобы съесть машину.
const STREAM_STDERR_CAP: usize = 8 * 1024;

pub struct ConnectOptions<'a> {
    pub host: &'a str,
    pub port: u16,
    pub user: &'a str,
    pub password: &'a [u8],
    pub known_hosts_path: PathBuf,
    pub timeout: Duration,
}

pub struct SshSession {
    pub(crate) handle: client::Handle<ClientHandler>,
}

pub async fn connect(opts: ConnectOptions<'_>) -> Result<SshSession, SshError> {
    connect_with_keepalive_override(opts, Some(KEEPALIVE_INTERVAL)).await
}

/// То же соединение, но с явно заданным интервалом keepalive (`None` — выключить).
///
/// Существует РАДИ ДОКАЗАТЕЛЬСТВА, а не ради настройки, и продуктовый код обязан
/// звать [`connect`]. Единственный вызывающий — интеграционный тест
/// `keepalive_carries_a_silent_command_past_the_inactivity_timeout`: утверждение
/// «keepalive держит молчащую команду» непроверяемо без пары «с ним / без него»
/// — зелёный тест был бы зелёным и с выключенным keepalive, если бы inactivity
/// просто оказался больше паузы. Интервал параметром по той же причине: с
/// продуктовыми 30 с такой тест шёл бы двумя минутами живого ожидания, а
/// доказываемый механизм (ответ на keepalive сдвигает inactivity) от величины
/// интервала не зависит — сами же 30 с и `KEEPALIVE_BUDGET` закреплены юнит-тестами
/// здесь и у каждого session-таймаута в `commands/`.
///
/// Отдельная функция, а не поле в [`ConnectOptions`]: поле выставляется где
/// угодно и копипастится вместе с остальными опциями, а функцию с таким именем
/// в продуктовом коде видно грепом.
pub async fn connect_with_keepalive_override(
    opts: ConnectOptions<'_>,
    keepalive_interval: Option<Duration>,
) -> Result<SshSession, SshError> {
    let pending = Arc::new(Mutex::new(None));
    let handler = ClientHandler {
        known_hosts_path: opts.known_hosts_path.clone(),
        expected_host: format!("{}:{}", opts.host, opts.port),
        pending_unknown_fp: pending.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(opts.timeout),
        // Без этих двух строк inactivity считает только принятые байты, и
        // молчащая живая команда неотличима от мёртвой связи — см.
        // `KEEPALIVE_INTERVAL`, там же и про то, что правка сквозная.
        keepalive_interval,
        keepalive_max: KEEPALIVE_MAX,
        ..Default::default()
    });

    let mut handle = match client::connect(config, (opts.host, opts.port), handler).await {
        Ok(h) => h,
        Err(SshConnectHandlerError::HostKeyMismatch) => return Err(SshError::HostKeyMismatch),
        Err(SshConnectHandlerError::Io(e)) => return Err(SshError::Io(e)),
        Err(SshConnectHandlerError::Russh(e)) => {
            if matches!(e, russh::Error::UnknownKey) {
                let fp = pending.lock().expect("lock").take();
                return if let Some(fingerprint) = fp {
                    Err(SshError::HostKeyUnknown { fingerprint })
                } else {
                    Err(SshError::Connect(e.to_string()))
                };
            }
            return Err(SshError::Connect(e.to_string()));
        }
    };

    let mut pwd = String::from_utf8_lossy(opts.password).into_owned();
    let auth_ok = handle
        .authenticate_password(opts.user, pwd.clone())
        .await
        .map_err(|e| SshError::Session(e.to_string()))?;
    pwd.zeroize();
    if !auth_ok {
        return Err(SshError::Auth {
            user: opts.user.to_string(),
            host: opts.host.to_string(),
            port: opts.port,
        });
    }
    Ok(SshSession { handle })
}

/// Итог потоковой команды: код возврата, сколько байт ушло в writer, хвост
/// stderr и сигнал, которым команду убили (если убили).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecStream {
    pub exit: i32,
    pub bytes: u64,
    pub stderr: String,
    /// Имя сигнала из `ChannelMsg::ExitSignal` — `KILL`, `TERM`, `PIPE`…
    ///
    /// Убитая команда кода возврата НЕ присылает, и без этого поля OOM-killer,
    /// съевший гигабайтный `tar`, выглядел бы ровно как «код не доехал» —
    /// то есть как исторический баг с `Eof`, который мы уже чинили.
    pub signal: Option<String>,
}

/// Накопитель stderr с жёстким потолком `STREAM_STDERR_CAP`.
///
/// Отдельный тип, а не проверка длины по месту, ради проверяемости: `ChannelMsg`
/// руками не собрать, мок всего russh ради одного `if` не стоит своей цены, а
/// потолок — то немногое в потоковом цикле, что можно проверить без сети.
///
/// Держим НАЧАЛО, а не хвост. Первая строка stderr — причина, всё остальное
/// обычно следствие; вдобавок «оставить начало» стоит O(1) на любом объёме, а
/// «оставить хвост» заставляло бы двигать буфер на каждом чанке гигабайтного
/// потока предупреждений. Чем кончилось дело, говорят `exit` и `signal`, а не
/// stderr.
#[derive(Default)]
struct CappedStderr {
    buf: Vec<u8>,
    dropped: u64,
}

impl CappedStderr {
    fn push(&mut self, chunk: &[u8]) {
        let room = STREAM_STDERR_CAP.saturating_sub(self.buf.len());
        let take = room.min(chunk.len());
        self.buf.extend_from_slice(&chunk[..take]);
        self.dropped = self.dropped.saturating_add((chunk.len() - take) as u64);
    }

    /// Отдать текст. Усечение НАЗЫВАЕТСЯ вслух: молча обрезанный stderr читается
    /// как «сервер больше ничего не сказал», а это разные вещи.
    ///
    /// `from_utf8_lossy` здесь уместен (в отличие от stdout, ради которого весь
    /// метод и затевался): stderr — текст для человека, а не байты файла.
    fn finish(self) -> String {
        let mut out = String::from_utf8_lossy(&self.buf).into_owned();
        if self.dropped > 0 {
            out.push_str(&format!(
                "\n… stderr truncated at {STREAM_STDERR_CAP} bytes, {} more dropped",
                self.dropped
            ));
        }
        out
    }
}

impl SshSession {
    /// Run a remote command. Use `pty = false` for non-interactive CLIs (FastPanel list, etc.).
    pub async fn exec(
        &mut self,
        cmd: &str,
        timeout: Duration,
        pty: bool,
    ) -> Result<(i32, String), SshError> {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Session(e.to_string()))?;
        if pty {
            channel
                .request_pty(true, "xterm", 80, 24, 0, 0, &[])
                .await
                .map_err(|e| SshError::Session(e.to_string()))?;
        }
        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| SshError::Session(e.to_string()))?;

        let mut output = Vec::new();
        let mut exit: i32 = -1;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => output.extend_from_slice(data.as_ref()),
                        Some(ChannelMsg::ExtendedData { data, .. }) => output.extend_from_slice(data.as_ref()),
                        Some(ChannelMsg::ExitStatus { exit_status }) => exit = exit_status as i32,
                        // EOF — НЕ конец разговора. OpenSSH закрывает поток вывода
                        // раньше, чем сообщает код возврата: сначала `Eof`, затем
                        // `exit-status`, и только потом `Close`. Выход из цикла по
                        // `Eof` терял код у КАЖДОЙ команды — `exec` всегда отдавал
                        // -1, из-за чего «SSH Test» краснел при живой связи, а все
                        // проверки `code != 0` в `fastpanel.rs` (установка панели,
                        // выпуск SSL, создание сайта) считали успех провалом.
                        // Воспроизведено на реальном OpenSSH: `tofu_then_exec_uname`
                        // в `tests/ssh_integration.rs` падал `left: -1, right: 0`.
                        // Так же устроен эталонный пример самого russh
                        // (`examples/client_exec_simple.rs`): «cannot leave the loop
                        // immediately, there might still be more data to receive».
                        Some(ChannelMsg::Eof) => {}
                        Some(ChannelMsg::Close) => break,
                        Some(_) => {}
                        None => break,
                    }
                }
                _ = tokio::time::sleep_until(deadline) => return Err(SshError::Session("exec timeout".into())),
            }
        }
        Ok((exit, String::from_utf8_lossy(&output).into_owned()))
    }

    /// Выполнить команду, отдавая её stdout В ПОТОК, а не в строку.
    ///
    /// Живёт рядом с [`exec`](Self::exec), а не вместо него, потому что `exec`
    /// для бинарного гигабайта непригоден трижды:
    /// - копит вывод в `Vec<u8>` и отдаёт `String::from_utf8_lossy` — каждый
    ///   невалидный UTF-8 стал бы U+FFFD, то есть архив был бы испорчен целиком;
    /// - сливает stdout и stderr в один буфер — одно предупреждение `tar`
    ///   вклеилось бы в середину файла;
    /// - его дедлайн суммарный (`now + timeout`), а не по бездействию — здоровая
    ///   многоминутная выгрузка обрывалась бы на середине.
    ///
    /// Здесь всё три наоборот: stdout уходит в `out` байт в байт, stderr копится
    /// отдельно и с потолком, а `idle_timeout` меряет ТИШИНУ — дедлайн
    /// сдвигается на каждом принятом сообщении, поэтому длительность команды не
    /// ограничена ничем, а замолчавший канал ловится за `idle_timeout`.
    ///
    /// Почему не крейт `russh-sftp`: SFTP закрывает один шаг из тринадцати —
    /// `tar`, `mysqldump`, `sha256sum`, замок и `rm -rf` всё равно идут через
    /// `exec`; исторический баг с `Eof`/`exit-status` оплачен именно в
    /// exec-цикле (см. комментарий внутри `exec` и план
    /// `plans/2026-08-06-ssh-exit-status-poteryan.md`), и цикл ниже это знание
    /// наследует, а SFTP-путь завёл бы свой набор граблей, не покрытый нашими
    /// тестами. Плюс ноль новых зависимостей.
    ///
    /// Исходов у выгрузки три, и они намеренно различимы: [`SshError::Cancelled`]
    /// — передумали сами, `SshError::Session("stream idle…")` — сервер молчит
    /// дольше `idle_timeout`, [`SshError::Disconnected`] — связь оборвалась, и
    /// написанное неполно. Нормальным концом считается только тот, при котором
    /// доехал итог команды (`exit-status` или сигнал).
    ///
    /// `on_progress` зовётся после каждой записи в `out` с накопленным числом
    /// байт; `ControlFlow::Break` останавливает выгрузку и даёт
    /// [`SshError::Cancelled`] — закрывается только канал, сессия остаётся живой
    /// и годной для следующей команды (после гигабайта на половине пути это
    /// важнее, чем кажется: переподключение стоило бы ещё одного TOFU-круга).
    ///
    /// Псевдотерминала здесь нет и быть не может — в отличие от `exec`, где это
    /// параметр: pty переводит `\n` в `\r\n`, то есть тихо портит каждый байт
    /// 0x0A. В текстовом выводе это косметика, в архиве — порча.
    pub async fn exec_to_writer<W, F>(
        &mut self,
        cmd: &str,
        idle_timeout: Duration,
        out: &mut W,
        mut on_progress: F,
    ) -> Result<ExecStream, SshError>
    where
        W: tokio::io::AsyncWrite + Unpin + Send,
        F: FnMut(u64) -> ControlFlow<()> + Send,
    {
        let mut channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| SshError::Session(e.to_string()))?;
        channel
            .exec(true, cmd.as_bytes())
            .await
            .map_err(|e| SshError::Session(e.to_string()))?;

        let mut stderr = CappedStderr::default();
        let mut bytes: u64 = 0;
        let mut exit: i32 = -1;
        let mut signal: Option<String> = None;
        // Доехал ли до нас ИТОГ команды (`exit-status` или сигнал). Отличает
        // нормальный конец канала от оборванной связи: и то и другое приходит
        // к нам одинаково — концом потока сообщений.
        let mut ended = false;
        // Выходим не через `return` из `select!`, а флагом: writer обязан быть
        // сброшен в любом исходе, иначе последний кусок остаётся в буфере.
        let mut stop: Option<SshError> = None;

        loop {
            // Дедлайн считается ЗАНОВО на каждом витке, то есть сдвигается на
            // каждом принятом сообщении. В этом вся разница с `exec`: там
            // `deadline` фиксирован один раз и ограничивает длительность
            // команды, здесь — только паузу между сообщениями.
            let deadline = tokio::time::Instant::now() + idle_timeout;
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            // Не `?`: выход по нему миновал бы и `flush`, и
                            // закрытие канала — то есть нарушил бы инвариант,
                            // объявленный при `stop`.
                            if let Err(e) = out.write_all(data.as_ref()).await {
                                stop = Some(SshError::Io(e));
                                break;
                            }
                            bytes = bytes.saturating_add(data.len() as u64);
                            if on_progress(bytes).is_break() {
                                stop = Some(SshError::Cancelled { bytes });
                                break;
                            }
                        }
                        // Вот ради этой строки метод и существует: в `exec`
                        // stderr идёт в тот же буфер, что stdout.
                        Some(ChannelMsg::ExtendedData { data, .. }) => stderr.push(data.as_ref()),
                        Some(ChannelMsg::ExitStatus { exit_status }) => {
                            exit = exit_status as i32;
                            ended = true;
                        }
                        // Убитая команда кода не присылает — присылает сигнал.
                        // Без этой ветки OOM-killer на гигабайтном `tar` был бы
                        // неотличим от «код не доехал».
                        Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                            signal = Some(match signal_name {
                                russh::Sig::Custom(name) => name,
                                known => format!("{known:?}"),
                            });
                            // Законный конец наравне с `exit-status`: требуй
                            // мы кода и от убитой команды — записали бы её в
                            // оборванные, а она честно доложила, как умерла.
                            ended = true;
                        }
                        // EOF — НЕ конец разговора. OpenSSH закрывает поток вывода
                        // раньше, чем сообщает код возврата: сначала `Eof`, затем
                        // `exit-status`. Выход из цикла по `Eof` терял код у
                        // КАЖДОЙ команды (см. подробный разбор в `exec` выше и
                        // план 2026-08-06) — здесь та же ловушка и тот же ответ
                        // на неё: ждём настоящего конца канала.
                        Some(ChannelMsg::Eof) => {}
                        // Страховка, а не рабочий путь: на russh 0.45 эта ветка
                        // не срабатывает НИ РАЗУ. Приняв `CHANNEL_CLOSE`, russh
                        // выкидывает канал из своей карты, не переслав наружу
                        // `ChannelMsg::Close` (`client/encrypted.rs`, ветка
                        // `msg::CHANNEL_CLOSE`), — и до нас доходит не `Close`,
                        // а конец потока. Оставлена на случай, если russh это
                        // поведение поменяет; смысл у неё тот же, что у `None`.
                        Some(ChannelMsg::Close) => break,
                        Some(_) => {}
                        // Единственный настоящий выход из цикла — и, вот
                        // ловушка, ОДИНАКОВЫЙ у нормального конца и у обрыва
                        // связи. Кто из двух — решает `ended` после цикла.
                        None => break,
                    }
                }
                _ = tokio::time::sleep_until(deadline) => {
                    // Текст намеренно не «exec timeout»: ту строку разбирают
                    // `exec_error`/`db_error` в `commands::provision`, и значит
                    // она обещает «команда не уложилась», а здесь случилось
                    // другое — канал замолчал.
                    stop = Some(SshError::Session(format!(
                        "stream idle: no data from the server for {idle_timeout:?}"
                    )));
                    break;
                }
            }
        }

        // Канал кончился, а итога не было — связь оборвалась. Раньше здесь
        // возвращался `Ok` с `exit: -1`, и обрезанный на середине архив был
        // неотличим от штатно закрытого потока.
        if stop.is_none() && !ended {
            stop = Some(SshError::Disconnected { bytes });
        }

        // Сброс — до разбора исхода, чтобы инвариант «writer сброшен в любом
        // случае» выполнялся и на пути ошибки. Но сама ошибка сброса НЕ
        // затирает уже установленную причину: отмена, превратившаяся в `Io`,
        // читалась бы как обрыв — ровно то, от чего её отделяли.
        let flushed = out.flush().await;
        if let Some(e) = stop {
            // Канал закрываем, сессию — нет: ни отмена, ни замолчавшая команда
            // не повод рвать соединение, по нему ещё пойдёт уборка (`rm -rf`).
            let _ = channel.close().await;
            return Err(e);
        }
        flushed?;
        Ok(ExecStream {
            exit,
            bytes,
            stderr: stderr.finish(),
            signal,
        })
    }

    pub async fn disconnect(&mut self) -> Result<(), SshError> {
        self.handle
            .disconnect(russh::Disconnect::ByApplication, "", "English")
            .await
            .map_err(|e| SshError::Session(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn read_append_known_host_roundtrip() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("kh");
        let hp = "10.0.0.1:22";
        assert_eq!(read_known_host(&p, hp).unwrap(), None);
        append_known_host(&p, hp, "abc123").unwrap();
        assert_eq!(
            read_known_host(&p, hp).unwrap().as_deref(),
            Some("abc123")
        );
        append_known_host(&p, "h:2222", "xyz").unwrap();
        assert_eq!(read_known_host(&p, hp).unwrap().as_deref(), Some("abc123"));
        assert_eq!(read_known_host(&p, "h:2222").unwrap().as_deref(), Some("xyz"));
    }

    /// Отказ аутентификации — единственная ошибка SSH, по которой пользователь
    /// обязан что-то СДЕЛАТЬ, а не просто повторить. Поэтому текст проверяется
    /// тестом: голое «auth failed» (а именно так и было) не отличает «пароль не
    /// тот» от «логин не тот», хотя логин берётся из поля сервера с молчаливым
    /// дефолтом `root` и чаще всего виноват именно он.
    #[test]
    fn auth_error_names_the_login_it_tried_and_the_two_ways_to_fix_it() {
        let msg = SshError::Auth {
            user: "deploy".into(),
            host: "10.0.0.7".into(),
            port: 2222,
        }
        .to_string();

        // Что именно пробовали — иначе «не тот логин» неотличим от «не тот пароль».
        assert!(msg.contains("deploy@10.0.0.7:2222"), "{msg}");
        // Обе причины названы: перебирать пароль бессмысленно на сервере,
        // который парольный вход не принимает вовсе.
        assert!(msg.contains("root"), "{msg}");
        assert!(msg.contains("PasswordAuthentication"), "{msg}");
    }

    // Бюджет — не третья независимая цифра, а следствие первых двух. Тест
    // держит их вместе: подняв `KEEPALIVE_MAX` и забыв про бюджет, автор
    // получил бы у всех вызывающих проверку соотношения по устаревшему числу.
    #[test]
    fn keepalive_budget_is_the_interval_times_every_attempt() {
        assert_eq!(
            KEEPALIVE_BUDGET,
            KEEPALIVE_INTERVAL * (KEEPALIVE_MAX as u32 + 1),
            "бюджет обязан равняться интервалу × (попытки + 1)"
        );
    }

    // Stderr короче потолка обязан доезжать дословно: приписка про усечение —
    // утверждение о потере, и на месте, где терять было нечего, она врала бы.
    #[test]
    fn stderr_under_the_cap_arrives_verbatim() {
        let mut acc = CappedStderr::default();
        acc.push(b"tar: /var/www/x: file changed as we read it\n");
        acc.push(b"gzip: broken pipe\n");
        let out = acc.finish();
        assert_eq!(
            out,
            "tar: /var/www/x: file changed as we read it\ngzip: broken pipe\n"
        );
        assert!(!out.contains("truncated"), "{out}");
    }

    // Потолок: гигабайтный stderr `tar` держится в памяти (в отличие от stdout),
    // поэтому обрезан он быть обязан — и обязан об этом сказать.
    #[test]
    fn stderr_over_the_cap_is_cut_and_says_how_much_was_lost() {
        let mut acc = CappedStderr::default();
        acc.push(&vec![b'e'; STREAM_STDERR_CAP - 1]);
        acc.push(b"XY"); // первый байт влезает, второй — уже нет
        acc.push(&vec![b'z'; 1000]);
        let out = acc.finish();

        // Сохранено НАЧАЛО: первая строка stderr — причина, остальное следствие.
        assert!(
            out.starts_with(&"e".repeat(STREAM_STDERR_CAP - 1)),
            "начало потеряно"
        );
        assert!(out.contains('X'), "последний влезающий байт потерян");
        assert!(!out.contains('z'), "потолок не сработал");
        // Потеря названа и посчитана: 1 байт "Y" + 1000 байт "z".
        assert!(out.contains("truncated"), "{}", &out[out.len() - 80..]);
        assert!(out.contains("1001 more"), "{}", &out[out.len() - 80..]);
    }

    // Отмена и обрыв — разные события, и текст обязан их различать: иначе
    // человек, сам нажавший «отмена», пойдёт чинить сеть.
    #[test]
    fn cancelled_reads_as_a_stopped_transfer_not_as_a_broken_link() {
        let msg = SshError::Cancelled { bytes: 4096 }.to_string();
        assert!(msg.contains("cancelled"), "{msg}");
        // Сколько успели — не украшение: по этому числу видно, что удалять.
        assert!(msg.contains("4096"), "{msg}");
        // Прямым текстом сказано, что связь цела.
        assert!(msg.contains("connection is fine"), "{msg}");
        // И это не тот таймаут, который разбирают в `commands::provision`.
        assert!(!msg.contains("timeout"), "{msg}");
    }

    // Третий исход. Раньше обрыв возвращался как `Ok(exit: -1)` — то есть
    // обрезанный архив выглядел штатно закрытым потоком. Теперь это ошибка, и
    // её текст обязан говорить главное: написанное НЕПОЛНО.
    #[test]
    fn disconnect_says_the_written_bytes_are_incomplete() {
        let msg = SshError::Disconnected { bytes: 1_048_576 }.to_string();
        assert!(msg.contains("connection lost"), "{msg}");
        assert!(msg.contains("1048576"), "{msg}");
        assert!(msg.contains("incomplete"), "{msg}");
        // Три исхода — три разных текста: обрыв не выдаёт себя ни за отмену,
        // ни за простой, иначе в аудите они слились бы в один случай.
        let cancelled = SshError::Cancelled { bytes: 1 }.to_string();
        assert!(!msg.contains("cancelled"), "{msg}");
        assert!(!cancelled.contains("connection lost"), "{cancelled}");
    }
}
