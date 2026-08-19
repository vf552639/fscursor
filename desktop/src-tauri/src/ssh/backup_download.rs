//! Выгрузка готового архива с сервера на диск пользователя: поток из
//! `exec_to_writer` → `<dest>.part` → проверка хеша и размера → `rename`.
//!
//! Отдельный модуль, а не тело Tauri-команды, по двум причинам, и обе
//! практические:
//!
//! 1. Здесь нет ни Tauri, ни keychain, ни кэша — только SSH-сессия и локальная
//!    ФС. Ровно так же устроен [`crate::ssh::backup_run`], который заканчивается
//!    словами «архив лежит на сервере, вот путь, размер и sha256». Этот модуль
//!    начинается с них же. Место, оставленное для S3/FTP, остаётся свободным:
//!    второй адресат — ещё один такой же модуль РЯДОМ, а не правка внутри.
//! 2. Доказать честность `HashingWriter` и `.part`→`rename` можно только на
//!    настоящем потоке, а интеграционные тесты живут отдельным крейтом и видят
//!    лишь публичные элементы библиотеки. Внутри `mod commands` (он приватный)
//!    эта проверка была бы невозможна.
//!
//! Главное решение модуля — **имя файла появляется последним**. Пишем в
//! `<dest>.part`, а `rename` делаем, только когда сошлись И sha256, И размер.
//! Иначе оборванная на середине выгрузка оставила бы на диске файл с правильным
//! именем и правильным расширением, который выглядит рабочим архивом и им не
//! является; узнать об этом человек мог бы через полгода, в момент
//! восстановления.

use std::io;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWrite;

use crate::ssh::client::{ExecStream, SshError, SshSession};
use crate::ssh::fastpanel::q;

/// Суффикс недоделанного файла. Публичный: по нему же уборка ищет мусор.
pub const PART_SUFFIX: &str = ".part";

/// Отказ выгрузки. Отдельный тип, а не строка: вызывающему надо отличать
/// «человек нажал отмену» от «файл доехал битым» — на экране это разные слова,
/// а в аудите разные события.
#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error(transparent)]
    Ssh(#[from] SshError),

    #[error("io: {0}")]
    Io(#[from] io::Error),

    /// Путь назначения приехал из вебвью и не выдержал проверки. Это не ошибка
    /// пользователя (он выбирает путь в нативной панели сохранения), а баг
    /// фронта — но узнать о нём мы обязаны здесь, до гигабайта трафика.
    #[error("destination path {path:?} is not usable: {reason}")]
    BadDestination { path: String, reason: String },

    /// Команда на сервере кончилась не нулём (или её убили).
    #[error("reading the archive on the server failed (exit {exit}{signal}): {stderr}")]
    RemoteFailed {
        exit: i32,
        signal: String,
        stderr: String,
    },

    /// Доехало не столько байт, сколько сервер насчитал ДО выгрузки.
    #[error(
        "the archive arrived truncated: the server measured {expected} bytes, {got} arrived. \
         Nothing was saved under the final name"
    )]
    SizeMismatch { expected: u64, got: u64 },

    /// Байт столько же, а содержимое другое.
    #[error(
        "checksum mismatch: the server computed {expected}, the downloaded file hashes to {got}. \
         Nothing was saved under the final name"
    )]
    ChecksumMismatch { expected: String, got: String },
}

impl DownloadError {
    /// Отмена — не сбой: связь цела, сервер жив, файл просто больше не нужен.
    /// Вызывающему это нужно отдельным вопросом, потому что на экране отмена
    /// обязана выглядеть иначе, чем оборванная выгрузка.
    pub fn is_cancelled(&self) -> bool {
        matches!(self, DownloadError::Ssh(SshError::Cancelled { .. }))
    }
}

/// Что доехало.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadOutcome {
    pub bytes: u64,
    pub sha256: String,
}

/// «Вылей команду сервера в этот writer» — ровно то, чем пользуется выгрузка.
///
/// Существует ради проверяемости, а не ради абстракции (та же мотивация, что у
/// `fastpanel::Exec`, и единственный прод-реализатор тут тоже один —
/// [`SshSession`]). Но правило «файл под целевым именем существует, только если
/// он целый» — центральное для модуля, а проверить его на живом SSH значит
/// проверять только там, где поднят докер. С трейтом обе сверки, разбор
/// `exit`/сигнала и судьба `.part` разыгрываются фейковым сервером в обычном
/// `cargo test`.
#[async_trait]
pub trait ArchiveStream: Send {
    async fn stream(
        &mut self,
        cmd: &str,
        idle_timeout: Duration,
        out: &mut (dyn AsyncWrite + Unpin + Send),
        on_progress: &mut (dyn FnMut(u64) -> ControlFlow<()> + Send),
    ) -> Result<ExecStream, SshError>;
}

#[async_trait]
impl ArchiveStream for SshSession {
    async fn stream(
        &mut self,
        cmd: &str,
        idle_timeout: Duration,
        out: &mut (dyn AsyncWrite + Unpin + Send),
        on_progress: &mut (dyn FnMut(u64) -> ControlFlow<()> + Send),
    ) -> Result<ExecStream, SshError> {
        // Пересадка `dyn` в дженерик: `exec_to_writer` требует `Sized`, а
        // `&mut dyn AsyncWrite` им и является (и сам реализует `AsyncWrite`).
        let mut w = out;
        self.exec_to_writer(cmd, idle_timeout, &mut w, on_progress)
            .await
    }
}

/// Писатель, который считает sha256 ПО ХОДУ записи.
///
/// Второго прохода по гигабайтам нет и быть не должно: перечитать файл целиком
/// ради хеша — это ещё раз столько же дискового чтения на машине, где только
/// что закончилась гигабайтная выгрузка.
///
/// Ловушка, ради которой этот тип написан руками, а не собран из готового:
/// `poll_write` НЕ обязан принять весь буфер. Он возвращает число фактически
/// принятых байт, и хешировать надо ровно этот префикс. Хеширование всего `buf`
/// давало бы расхождение с содержимым файла ровно на частичных записях — то
/// есть на больших файлах и под нагрузкой, и никогда в маленьком тесте.
pub struct HashingWriter<W> {
    inner: W,
    hasher: Sha256,
    written: u64,
}

impl<W> HashingWriter<W> {
    pub fn new(inner: W) -> Self {
        HashingWriter {
            inner,
            hasher: Sha256::new(),
            written: 0,
        }
    }

    /// Хеш в hex и число записанных байт.
    pub fn finish(self) -> (String, u64) {
        let (_, sha, bytes) = self.into_parts();
        (sha, bytes)
    }

    /// То же, но с возвратом самого writer'а — он нужен, чтобы дожать файл на
    /// диск (`sync_all`) до переименования.
    pub fn into_parts(self) -> (W, String, u64) {
        (
            self.inner,
            hex::encode(self.hasher.finalize()),
            self.written,
        )
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for HashingWriter<W> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        match Pin::new(&mut me.inner).poll_write(cx, buf) {
            // Только принятый префикс — см. комментарий к типу.
            Poll::Ready(Ok(n)) => {
                me.hasher.update(&buf[..n]);
                me.written = me.written.saturating_add(n as u64);
                Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// Проверить путь, пришедший из вебвью.
///
/// Защита не от пользователя, а от бага фронта: путь выбирается нативной
/// панелью сохранения, но между ней и Rust лежит JS, который однажды пришлёт
/// пустую строку, относительный путь или каталог. Узнать об этом дешевле
/// сейчас, чем после часа `tar` на продакшне.
///
/// Существующий файл НЕ отвергается: панель сохранения уже спросила про
/// перезапись, и второй вопрос отсюда был бы вопросом о том, о чём человек уже
/// сказал «да».
pub fn validate_dest_path(dest: &str) -> Result<PathBuf, DownloadError> {
    let bad = |reason: &str| DownloadError::BadDestination {
        path: dest.to_string(),
        reason: reason.to_string(),
    };

    if dest.trim().is_empty() {
        return Err(bad("it is empty"));
    }
    let path = Path::new(dest);
    if !path.is_absolute() {
        return Err(bad("it is not absolute"));
    }
    // `file_name()` отсутствует у `/` и у путей, кончающихся на `..`.
    if path.file_name().is_none() {
        return Err(bad("it does not name a file"));
    }
    if path.is_dir() {
        return Err(bad("it is an existing directory"));
    }
    let parent = path.parent().ok_or_else(|| bad("it has no parent"))?;
    if !parent.is_dir() {
        return Err(bad("its parent directory does not exist"));
    }
    Ok(path.to_path_buf())
}

/// Путь недоделанного файла: `<dest>.part`.
///
/// Именно суффикс к полному имени, а не подмена расширения: рядом с
/// `site.tar` должен лежать `site.tar.part`, чтобы человек, увидевший его в
/// файловом менеджере, понял, чей это огрызок.
///
/// Имя огрызка определяется ТОЛЬКО путём назначения, и это известная дыра в
/// экзотическом случае: два бэкапа РАЗНЫХ доменов, которым человек выбрал один
/// и тот же `dest_path`, пишут в один `.part`, и сторож одного снесёт файл
/// другого. Замок на сервере сюда не достаёт (он на домен), реестр прогонов
/// тоже (ключ — домен). Не чинится штампом в имени намеренно: тогда после
/// падения на диске оставались бы `site.tar.a1b2.part`, которые никто никогда
/// не уберёт, — а лечится это тем, что путь приходит из нативной панели
/// сохранения, где два одинаковых имени подряд надо выбрать руками.
pub fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_os_string();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

/// Сторож недоделанного файла.
///
/// Удаляет `.part` в `Drop`, то есть на ЛЮБОМ пути выхода: ранний `?`, паника,
/// брошенный фьючер (карточку закрыли, команда отменена рантаймом). Явный
/// `remove_file` в конце функции покрывал бы только те пути, о которых автор
/// вспомнил, а их у выгрузки много.
///
/// Внутри `Drop` используется синхронный `std::fs::remove_file`: async в
/// деструкторе не бывает вовсе, а это один syscall по уже известному пути.
struct PartGuard {
    path: PathBuf,
    armed: bool,
}

impl PartGuard {
    fn new(path: PathBuf) -> Self {
        PartGuard { path, armed: true }
    }

    /// Файл уехал под настоящее имя — сторожить больше нечего.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PartGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Скачать файл с сервера, проверить его и положить под настоящим именем.
///
/// `expected_sha256`/`expected_bytes` — то, что сервер измерил ДО выгрузки
/// (шаг `checksum` в [`crate::ssh::backup_run`]). Только так скачавший может
/// доказать, что довёз файл целиком: хеш, посчитанный по тому же потоку, что и
/// записан, доказывает лишь отсутствие ошибок в памяти.
///
/// `on_progress` зовётся из `exec_to_writer` после каждой записи; вернув
/// `ControlFlow::Break`, вызывающий отменяет выгрузку — реакция мгновенная, а
/// не «на следующем шаге». Троттлинг событий — забота вызывающего: сюда чанки
/// приходят по 32 KiB, то есть ~32 тысячи раз на гигабайт.
pub async fn download_archive<S, F>(
    session: &mut S,
    remote_path: &str,
    dest: &Path,
    expected_sha256: &str,
    expected_bytes: u64,
    idle_timeout: Duration,
    on_progress: F,
) -> Result<DownloadOutcome, DownloadError>
where
    S: ArchiveStream + ?Sized,
    F: FnMut(u64) -> ControlFlow<()> + Send,
{
    let part = part_path(dest);
    // Сторож ставится ДО создания файла: между `create` и первым `?` тоже есть
    // пути выхода.
    let mut guard = PartGuard::new(part.clone());

    let outcome = stream_into_part(
        session,
        remote_path,
        &part,
        expected_sha256,
        expected_bytes,
        idle_timeout,
        on_progress,
    )
    .await?;

    // Переименование — единственное место, где на диске появляется файл под
    // настоящим именем, и оно стоит ПОСЛЕ обеих проверок внутри
    // `stream_into_part`. Провалилось само переименование — сторож снесёт
    // `.part`, и на диске не останется ничего похожего на архив.
    tokio::fs::rename(&part, dest).await?;
    guard.disarm();
    Ok(outcome)
}

/// Тело выгрузки: поток → `.part` → сверка. Вынесено, чтобы у сторожа из
/// [`download_archive`] был ровно один выход и ни одного забытого `?`.
async fn stream_into_part<S, F>(
    session: &mut S,
    remote_path: &str,
    part: &Path,
    expected_sha256: &str,
    expected_bytes: u64,
    idle_timeout: Duration,
    on_progress: F,
) -> Result<DownloadOutcome, DownloadError>
where
    S: ArchiveStream + ?Sized,
    F: FnMut(u64) -> ControlFlow<()> + Send,
{
    let file = tokio::fs::File::create(part).await?;
    // Буфер между сетью и диском: чанки приезжают по 32 KiB, и без него каждый
    // из них был бы отдельным `write(2)`.
    let mut writer = HashingWriter::new(tokio::io::BufWriter::new(file));

    // `cat`, а не `dd`/`base64`: поток бинарный и идёт байт в байт (об этом
    // `exec_to_writer` — там нет ни pty, ни `from_utf8_lossy`), а всё
    // остальное добавило бы преобразование, которое нечем проверить.
    let cmd = format!("cat {}", q(remote_path));
    let mut on_progress = on_progress;
    let stream = session
        .stream(&cmd, idle_timeout, &mut writer, &mut on_progress)
        .await?;

    let (buffered, sha256, bytes) = writer.into_parts();

    // Убитая команда приезжает как `Ok` с сигналом и `exit: -1` — она честно
    // доложила, как умерла. Проверять один только `exit` здесь мало: `cat`,
    // прибитый на середине гигабайта, отдал бы ровно такой ответ.
    if stream.exit != 0 || stream.signal.is_some() {
        return Err(DownloadError::RemoteFailed {
            exit: stream.exit,
            signal: stream
                .signal
                .as_ref()
                .map(|s| format!(", signal {s}"))
                .unwrap_or_default(),
            stderr: trim_stderr(&stream.stderr),
        });
    }

    // Размер и хеш проверяются ОБА, и это не избыточность: размер ловит
    // усечение сразу и называет его своим именем, а хеш ловит порчу внутри
    // доехавших байт. Сообщения у них разные, потому что чинить их надо
    // по-разному.
    if bytes != expected_bytes {
        return Err(DownloadError::SizeMismatch {
            expected: expected_bytes,
            got: bytes,
        });
    }
    if !sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err(DownloadError::ChecksumMismatch {
            expected: expected_sha256.to_string(),
            got: sha256,
        });
    }

    // `fsync` перед переименованием — решение, а не привычка. `exec_to_writer`
    // гарантирует `flush`, то есть «байты отданы ядру», но не «байты на диске»:
    // между записью и `rename` пропавшее питание оставило бы файл под ЦЕЛЕВЫМ
    // именем с дырами внутри — ровно то, против чего построен `.part`. Платим
    // за это одним ожиданием сброса кеша (на гигабайтах — секунды) и платим
    // только здесь: на пути отказа файл всё равно будет снесён.
    //
    // Дальше `rename` — метаданная операция; порядок «сначала данные, потом
    // имя» и есть весь смысл: переименование не может опередить содержимое.
    let file = buffered.into_inner();
    file.sync_all().await?;

    Ok(DownloadOutcome { bytes, sha256 })
}

fn trim_stderr(s: &str) -> String {
    let t = s.trim();
    let cut: String = t.chars().take(300).collect();
    cut.replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    fn sha_hex(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    /// Писатель, который принимает не больше `chunk` байт за раз, — то есть
    /// ведёт себя так, как ведёт себя настоящий сокет/файл под нагрузкой.
    struct StingyWriter {
        got: Vec<u8>,
        chunk: usize,
    }

    impl AsyncWrite for StingyWriter {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            let me = self.get_mut();
            let n = buf.len().min(me.chunk);
            me.got.extend_from_slice(&buf[..n]);
            Poll::Ready(Ok(n))
        }
        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    // Базовая честность: хеш совпадает с хешем того, что реально записано.
    #[tokio::test]
    async fn the_hash_matches_what_actually_landed_in_the_writer() {
        let data: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        let mut w = HashingWriter::new(Vec::new());
        w.write_all(&data).await.unwrap();
        w.flush().await.unwrap();
        let inner_copy = data.clone();
        let (hash, bytes) = w.finish();
        assert_eq!(bytes, 10_000);
        assert_eq!(hash, sha_hex(&inner_copy));
    }

    // Главный тест типа: частичные записи. Хешируй мы весь `buf`, а не
    // принятый префикс, здесь пришёл бы хеш каждого куска по нескольку раз —
    // и разошёлся бы с содержимым файла ровно на больших выгрузках.
    #[tokio::test]
    async fn a_partial_write_hashes_only_the_bytes_the_writer_took() {
        let data: Vec<u8> = (0..=255u8).cycle().take(4_097).collect();
        let mut w = HashingWriter::new(StingyWriter {
            got: Vec::new(),
            chunk: 7,
        });
        w.write_all(&data).await.unwrap();
        w.flush().await.unwrap();
        let (hash, bytes) = w.finish();
        assert_eq!(bytes, data.len() as u64);
        assert_eq!(hash, sha_hex(&data));
    }

    // Пустой файл — тоже файл: хеш пустоты обязан быть хешем пустоты, а не
    // «чем-нибудь». Иначе нулевой архив прошёл бы сверку с сервером.
    #[tokio::test]
    async fn an_empty_stream_hashes_to_the_hash_of_nothing() {
        let w: HashingWriter<Vec<u8>> = HashingWriter::new(Vec::new());
        let (hash, bytes) = w.finish();
        assert_eq!(bytes, 0);
        assert_eq!(
            hash,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    // ---- выгрузка целиком, на фейковом сервере ------------------------------

    /// Сервер, который отдаёт заданные куски и заканчивается заданным исходом.
    ///
    /// Куски — несколько, а не один: только так в дело идут повторные
    /// `poll_write`, накопление хеша и колбэк прогресса.
    struct FakeStream {
        chunks: Vec<Vec<u8>>,
        exit: i32,
        signal: Option<String>,
        stderr: String,
        /// Оборвать поток после N-го куска (обрыв связи).
        die_after: Option<usize>,
    }

    impl FakeStream {
        fn serving(chunks: &[&[u8]]) -> Self {
            FakeStream {
                chunks: chunks.iter().map(|c| c.to_vec()).collect(),
                exit: 0,
                signal: None,
                stderr: String::new(),
                die_after: None,
            }
        }
    }

    #[async_trait]
    impl ArchiveStream for FakeStream {
        async fn stream(
            &mut self,
            _cmd: &str,
            _idle: Duration,
            out: &mut (dyn AsyncWrite + Unpin + Send),
            on_progress: &mut (dyn FnMut(u64) -> ControlFlow<()> + Send),
        ) -> Result<ExecStream, SshError> {
            let mut done: u64 = 0;
            for (i, c) in self.chunks.iter().enumerate() {
                out.write_all(c).await?;
                done += c.len() as u64;
                if on_progress(done).is_break() {
                    out.flush().await?;
                    return Err(SshError::Cancelled { bytes: done });
                }
                if self.die_after == Some(i + 1) {
                    out.flush().await?;
                    return Err(SshError::Disconnected { bytes: done });
                }
            }
            out.flush().await?;
            Ok(ExecStream {
                exit: self.exit,
                bytes: done,
                stderr: self.stderr.clone(),
                signal: self.signal.clone(),
            })
        }
    }

    fn body() -> Vec<u8> {
        (0..=255u8).cycle().take(70_000).collect()
    }

    fn served(data: &[u8]) -> FakeStream {
        // Три куска, последний неровный — как оно и приходит по сети.
        let (a, rest) = data.split_at(32_768);
        let (b, c) = rest.split_at(32_768);
        FakeStream::serving(&[a, b, c])
    }

    /// Скачать `data` в `dir/archive.tar`, обещав сервером `(sha, bytes)`.
    async fn download_to(
        dir: &Path,
        mut src: FakeStream,
        expected_sha: &str,
        expected_bytes: u64,
    ) -> (PathBuf, Result<DownloadOutcome, DownloadError>) {
        let dest = dir.join("archive.tar");
        let r = download_archive(
            &mut src,
            "/var/tmp/sdmp-backup/example.com-20260819T103000Z.tar",
            &dest,
            expected_sha,
            expected_bytes,
            Duration::from_secs(5),
            |_| ControlFlow::Continue(()),
        )
        .await;
        (dest, r)
    }

    // Здоровый путь: файл под настоящим именем, огрызка нет, содержимое то же.
    #[tokio::test]
    async fn a_stream_the_server_vouched_for_lands_under_the_real_name() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        let (dest, r) = download_to(dir.path(), served(&data), &sha_hex(&data), data.len() as u64)
            .await;
        let got = r.expect("выгрузка");
        assert_eq!(got.bytes, data.len() as u64);
        assert_eq!(got.sha256, sha_hex(&data));
        assert!(dest.exists());
        assert!(!part_path(&dest).exists(), "огрызок остался");
        assert_eq!(std::fs::read(&dest).unwrap(), data);
    }

    // Размер не тот, что обещал сервер, — отказ, и на диске НИЧЕГО. Это
    // отдельная от хеша сверка: убери её, и усечённый архив, чей хеш никто не
    // сверял бы с правильным, доехал бы под настоящим именем.
    #[tokio::test]
    async fn a_size_the_server_did_not_promise_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        // Хеш — настоящий, размер сервер насчитал больше: ровно так выглядит
        // усечённая на сервере выгрузка.
        let (dest, r) = download_to(
            dir.path(),
            served(&data),
            &sha_hex(&data),
            data.len() as u64 + 1,
        )
        .await;
        let e = r.expect_err("размер обязан быть сверен");
        assert!(matches!(e, DownloadError::SizeMismatch { .. }), "{e}");
        assert!(!dest.exists(), "битый файл лёг под настоящим именем");
        assert!(!part_path(&dest).exists(), "огрызок остался");
    }

    // Байт столько же, содержимое другое — вторая сверка, и она тоже одна на
    // весь модуль.
    #[tokio::test]
    async fn a_body_the_server_did_not_promise_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        let (dest, r) = download_to(dir.path(), served(&data), &"0".repeat(64), data.len() as u64)
            .await;
        let e = r.expect_err("хеш обязан быть сверен");
        assert!(matches!(e, DownloadError::ChecksumMismatch { .. }), "{e}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    // Убитая команда приезжает `Ok`'ом с сигналом — и всё сошлось бы по
    // размеру и хешу, потому что сервер отдал ровно то, что успел. Проверять
    // один `exit` тут мало.
    #[tokio::test]
    async fn a_command_that_was_killed_is_not_a_finished_download() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        let mut src = served(&data);
        src.exit = -1;
        src.signal = Some("KILL".into());
        let (dest, r) = download_to(dir.path(), src, &sha_hex(&data), data.len() as u64).await;
        let e = r.expect_err("сигнал обязан быть отказом");
        assert!(matches!(e, DownloadError::RemoteFailed { .. }), "{e}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    #[tokio::test]
    async fn a_nonzero_exit_is_not_a_finished_download() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        let mut src = served(&data);
        src.exit = 1;
        src.stderr = "cat: no such file".into();
        let (dest, r) = download_to(dir.path(), src, &sha_hex(&data), data.len() as u64).await;
        let e = r.expect_err("ненулевой код обязан быть отказом");
        assert!(format!("{e}").contains("no such file"), "{e}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    // Оборванная связь: доехало меньше, чем обещано. Ни файла, ни огрызка.
    #[tokio::test]
    async fn a_broken_link_leaves_neither_the_file_nor_the_part() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        let mut src = served(&data);
        src.die_after = Some(1);
        let (dest, r) = download_to(dir.path(), src, &sha_hex(&data), data.len() as u64).await;
        let e = r.expect_err("обрыв обязан быть отказом");
        assert!(
            matches!(e, DownloadError::Ssh(SshError::Disconnected { .. })),
            "{e}"
        );
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    // Отмена посреди выгрузки: тоже пусто на диске, но исход опознаётся иначе.
    #[tokio::test]
    async fn a_cancelled_download_leaves_no_file_either() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        let dest = dir.path().join("archive.tar");
        let mut src = served(&data);
        let r = download_archive(
            &mut src,
            "/var/tmp/sdmp-backup/example.com-20260819T103000Z.tar",
            &dest,
            &sha_hex(&data),
            data.len() as u64,
            Duration::from_secs(5),
            // Ломаемся на первом же чанке — так это и выглядит у человека,
            // нажавшего «отмена» на второй минуте.
            |_| ControlFlow::Break(()),
        )
        .await;
        let e = r.expect_err("отмена обязана быть отказом");
        assert!(e.is_cancelled(), "{e}");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
    }

    // Прогресс доезжает до вызывающего нарастающим итогом — на этом стоит и
    // троттлинг, и реакция на отмену.
    #[tokio::test]
    async fn progress_arrives_as_a_running_total() {
        let dir = tempfile::tempdir().unwrap();
        let data = body();
        let dest = dir.path().join("archive.tar");
        let mut seen: Vec<u64> = Vec::new();
        let mut src = served(&data);
        download_archive(
            &mut src,
            "/var/tmp/x.tar",
            &dest,
            &sha_hex(&data),
            data.len() as u64,
            Duration::from_secs(5),
            |done| {
                seen.push(done);
                ControlFlow::Continue(())
            },
        )
        .await
        .unwrap();
        assert_eq!(seen, vec![32_768, 65_536, 70_000]);
    }

    // `.part` — суффикс к полному имени, а не подмена расширения.
    #[test]
    fn the_unfinished_file_sits_next_to_the_real_name() {
        let p = part_path(Path::new("/tmp/a/site.tar"));
        assert_eq!(p, PathBuf::from("/tmp/a/site.tar.part"));
    }

    // Сторож удаляет огрызок и при раннем выходе, и при панике — оба пути
    // выхода одинаково реальны у выгрузки, которая идёт минутами.
    #[test]
    fn the_guard_removes_the_part_file_even_when_the_run_panics() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("x.tar.part");
        std::fs::write(&part, b"half").unwrap();

        let p2 = part.clone();
        let r = std::panic::catch_unwind(move || {
            let _g = PartGuard::new(p2);
            panic!("boom");
        });
        assert!(r.is_err());
        assert!(!part.exists(), "огрызок пережил панику");
    }

    #[test]
    fn a_disarmed_guard_keeps_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let part = dir.path().join("y.tar.part");
        std::fs::write(&part, b"done").unwrap();
        {
            let mut g = PartGuard::new(part.clone());
            g.disarm();
        }
        assert!(part.exists());
    }

    // Три формы битого пути из вебвью, каждая — реальный баг фронта: пустая
    // строка (диалог отменили, но вызвали команду), относительный путь
    // (склеили имя без каталога), несуществующий родитель (каталог удалили,
    // пока висел диалог).
    #[test]
    fn an_empty_destination_is_refused() {
        let e = validate_dest_path("").unwrap_err();
        assert!(format!("{e}").contains("empty"), "{e}");
        let e = validate_dest_path("   ").unwrap_err();
        assert!(format!("{e}").contains("empty"), "{e}");
    }

    #[test]
    fn a_relative_destination_is_refused() {
        let e = validate_dest_path("backups/site.tar").unwrap_err();
        assert!(format!("{e}").contains("absolute"), "{e}");
        let e = validate_dest_path("./site.tar").unwrap_err();
        assert!(format!("{e}").contains("absolute"), "{e}");
    }

    #[test]
    fn a_destination_whose_parent_does_not_exist_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("no-such-dir").join("site.tar");
        let e = validate_dest_path(p.to_str().unwrap()).unwrap_err();
        assert!(format!("{e}").contains("parent"), "{e}");
    }

    #[test]
    fn a_destination_that_is_a_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let e = validate_dest_path(dir.path().to_str().unwrap()).unwrap_err();
        assert!(format!("{e}").contains("directory"), "{e}");
    }

    // Здоровый путь и здоровый путь поверх существующего файла: панель
    // сохранения про перезапись уже спросила.
    #[test]
    fn a_usable_destination_passes_even_when_the_file_is_already_there() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("site.tar");
        assert_eq!(validate_dest_path(p.to_str().unwrap()).unwrap(), p);
        std::fs::write(&p, b"old").unwrap();
        assert_eq!(validate_dest_path(p.to_str().unwrap()).unwrap(), p);
    }

    // Отмена обязана быть отличима от порчи файла: на экране это разные слова.
    #[test]
    fn cancellation_is_not_reported_as_a_broken_download() {
        let cancelled = DownloadError::Ssh(SshError::Cancelled { bytes: 10 });
        assert!(cancelled.is_cancelled());
        assert!(!DownloadError::SizeMismatch {
            expected: 10,
            got: 9
        }
        .is_cancelled());
        assert!(!DownloadError::Ssh(SshError::Disconnected { bytes: 10 }).is_cancelled());
    }

    // Тексты обеих сверок обязаны говорить главное: под настоящим именем НЕ
    // сохранено ничего. Иначе человек пойдёт искать файл, которого нет.
    #[test]
    fn both_integrity_failures_say_that_nothing_was_saved() {
        let size = DownloadError::SizeMismatch {
            expected: 4096,
            got: 100,
        }
        .to_string();
        assert!(size.contains("4096") && size.contains("100"), "{size}");
        assert!(size.contains("Nothing was saved"), "{size}");

        let sum = DownloadError::ChecksumMismatch {
            expected: "aa".into(),
            got: "bb".into(),
        }
        .to_string();
        assert!(sum.contains("aa") && sum.contains("bb"), "{sum}");
        assert!(sum.contains("Nothing was saved"), "{sum}");
    }
}
