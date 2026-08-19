//! Integration tests against a local SSH server (e.g. linuxserver/openssh-server on port 2222).
//!
//! ```bash
//! docker run -d --name sdmp-test-ssh \
//!   -e PASSWORD_ACCESS=true -e USER_NAME=test -e USER_PASSWORD=testpass \
//!   -p 2222:2222 lscr.io/linuxserver/openssh-server:latest
//! ```
//!
//! Run: `cargo test -p sdmp-desktop --features ssh_integration --test ssh_integration -- --ignored --nocapture`

use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

use sdmp_desktop_lib::ssh::backup_download::{
    download_archive, part_path, DownloadError,
};
use sdmp_desktop_lib::ssh::backup_run::{
    build_cleanup_cmd, build_lock_cmd, build_lock_probe_cmd, parse_lock_probe,
    parse_pipeline_status, PIPE_STATUS_TAIL,
};
use sdmp_desktop_lib::ssh::client::{
    append_known_host, connect, connect_with_keepalive_override, read_known_host, ConnectOptions,
    SshError, SshSession, KEEPALIVE_INTERVAL,
};

fn ssh_addr() -> (&'static str, u16) {
    let host = std::env::var("SDMP_SSH_TEST_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port: u16 = std::env::var("SDMP_SSH_TEST_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2222);
    // linuxserver image uses host string in tests — leak Box::leak for static ref simplicity
    let host: &'static str = Box::leak(host.into_boxed_str());
    (host, port)
}

fn opts<'a>(host: &'a str, port: u16, kh: &Path, timeout: Duration) -> ConnectOptions<'a> {
    ConnectOptions {
        host,
        port,
        user: "test",
        password: b"testpass",
        known_hosts_path: kh.to_path_buf(),
        timeout,
    }
}

/// TOFU и подключение одной строкой: первый `connect` отдаёт отпечаток, кладём
/// его в known_hosts и подключаемся всерьёз.
///
/// Ровно эту последовательность проверяет `tofu_then_exec_uname`; остальным
/// тестам она — прелюдия, и повторять её в каждом значит проверять TOFU шесть
/// раз вместо одного. `keepalive_interval` пробрасывается наружу только ради
/// теста keepalive (см. его комментарий), все прочие берут продуктовое значение.
async fn trusted_session(
    kh: &Path,
    timeout: Duration,
    keepalive_interval: Option<Duration>,
) -> SshSession {
    let (host, port) = ssh_addr();
    let hp = format!("{host}:{port}");
    if read_known_host(kh, &hp).unwrap().is_none() {
        match connect(opts(host, port, kh, timeout)).await {
            Err(SshError::HostKeyUnknown { fingerprint }) => {
                append_known_host(kh, &hp, &fingerprint).unwrap()
            }
            Ok(_) => panic!("expected unknown host on empty known_hosts"),
            Err(e) => panic!("unexpected error: {e}"),
        }
    }
    connect_with_keepalive_override(opts(host, port, kh, timeout), keepalive_interval)
        .await
        .expect("connect")
}

fn never_cancels(_: u64) -> ControlFlow<()> {
    ControlFlow::Continue(())
}

#[tokio::test]
#[ignore = "requires docker ssh on SDMP_SSH_TEST_HOST:SDMP_SSH_TEST_PORT"]
async fn tofu_then_exec_uname() {
    let (host, port) = ssh_addr();
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");

    let opts = ConnectOptions {
        host,
        port,
        user: "test",
        password: b"testpass",
        known_hosts_path: kh.clone(),
        timeout: Duration::from_secs(20),
    };

    let fp = match connect(opts).await {
        Err(SshError::HostKeyUnknown { fingerprint }) => fingerprint,
        Ok(_) => panic!("expected unknown host on empty known_hosts"),
        Err(e) => panic!("unexpected error: {e}"),
    };

    append_known_host(&kh, &format!("{host}:{port}"), &fp).unwrap();
    assert!(read_known_host(&kh, &format!("{host}:{port}"))
        .unwrap()
        .is_some());

    let opts2 = ConnectOptions {
        host,
        port,
        user: "test",
        password: b"testpass",
        known_hosts_path: kh.clone(),
        timeout: Duration::from_secs(20),
    };
    let mut sess = connect(opts2).await.expect("second connect");
    let (code, out) = sess
        .exec("uname -a", Duration::from_secs(30), false)
        .await
        .expect("exec");
    assert_eq!(code, 0);
    assert!(out.to_lowercase().contains("linux"), "{}", out);

    // Ненулевой код обязан доезжать так же, как нулевой. Без этой проверки
    // «всегда 0» выглядело бы ровно так же зелено, как честный разбор
    // `exit-status`, — а стоило бы дороже прежнего -1: провал команды
    // молча читался бы как успех. 3 — произвольное некруглое число, чтобы
    // случайное совпадение с дефолтом было заметно.
    let (code_fail, _) = sess
        .exec("exit 3", Duration::from_secs(30), false)
        .await
        .expect("exec exit 3");
    assert_eq!(code_fail, 3, "ненулевой код возврата не доехал");

    // stderr тоже собирается (`ExtendedData`), и код при этом остаётся 0:
    // болтливая в stderr, но успешная команда не должна выглядеть провалом.
    let (code_err, out_err) = sess
        .exec("echo boom >&2", Duration::from_secs(30), false)
        .await
        .expect("exec stderr");
    assert_eq!(code_err, 0);
    assert!(out_err.contains("boom"), "stderr потерян: {out_err}");

    let _ = sess.disconnect().await;
}

#[tokio::test]
#[ignore = "requires docker ssh"]
async fn host_key_mismatch() {
    let (host, port) = ssh_addr();
    let tmp = tempfile::tempdir().unwrap();
    let kh: PathBuf = tmp.path().join("known_hosts");
    append_known_host(&kh, &format!("{host}:{port}"), "bogusfingerprintnotreal")
        .unwrap();

    let opts = ConnectOptions {
        host,
        port,
        user: "test",
        password: b"testpass",
        known_hosts_path: kh,
        timeout: Duration::from_secs(20),
    };
    let r = connect(opts).await;
    assert!(matches!(r, Err(SshError::HostKeyMismatch)));
}

/// Три мегабайта случайных байт обязаны доехать байт в байт.
///
/// Ловит сразу обе порчи, ради которых `exec_to_writer` и появился:
/// `from_utf8_lossy` из `exec` заменил бы каждый невалидный UTF-8 на U+FFFD, а
/// псевдотерминал превратил бы каждый 0x0A в 0x0D 0x0A. И то и другое на
/// текстовом выводе незаметно, а здесь ломает и длину, и sha256.
#[tokio::test]
#[ignore = "requires docker ssh"]
async fn exec_to_writer_hands_over_binary_bytes_untouched() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut sess = trusted_session(&kh, Duration::from_secs(30), Some(KEEPALIVE_INTERVAL)).await;

    // Эталон считает сам сервер: сравнение «поток против sha256sum на той
    // стороне» не зависит ни от одной нашей строчки разбора.
    let (code, sum) = sess
        .exec(
            "head -c 3000000 /dev/urandom > /tmp/sdmp-blob && sha256sum /tmp/sdmp-blob | cut -d' ' -f1",
            Duration::from_secs(60),
            false,
        )
        .await
        .expect("make blob");
    assert_eq!(code, 0, "{sum}");
    let expected = sum.trim().to_string();

    let mut buf: Vec<u8> = Vec::new();
    let r = sess
        .exec_to_writer(
            "cat /tmp/sdmp-blob",
            Duration::from_secs(30),
            &mut buf,
            never_cancels,
        )
        .await
        .expect("stream blob");

    assert_eq!(r.exit, 0);
    assert_eq!(r.bytes, 3_000_000, "счётчик байт разошёлся с файлом");
    assert_eq!(buf.len(), 3_000_000, "длина потока разошлась с файлом");
    assert_eq!(
        hex::encode(Sha256::digest(&buf)),
        expected,
        "байты испорчены"
    );
    assert!(r.stderr.is_empty(), "stderr взялся ниоткуда: {}", r.stderr);
    assert_eq!(r.signal, None);

    let _ = sess
        .exec("rm -f /tmp/sdmp-blob", Duration::from_secs(30), false)
        .await;
    let _ = sess.disconnect().await;
}

/// Stderr не имеет права попасть в файл.
///
/// Прямая защита от болезни `exec`, который копит оба потока в один буфер: там
/// предупреждение `tar` вклеилось бы в середину архива. Три байта stdout взяты
/// нулевые и неотображаемые нарочно — на них видно и слияние потоков, и любую
/// текстовую обработку по дороге.
#[tokio::test]
#[ignore = "requires docker ssh"]
async fn stderr_never_lands_in_the_stream() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut sess = trusted_session(&kh, Duration::from_secs(30), Some(KEEPALIVE_INTERVAL)).await;

    let mut buf: Vec<u8> = Vec::new();
    let r = sess
        .exec_to_writer(
            r#"echo noise >&2; printf '\000\001\002'"#,
            Duration::from_secs(30),
            &mut buf,
            never_cancels,
        )
        .await
        .expect("stream");

    assert_eq!(buf, vec![0u8, 1, 2], "в файл попало лишнее");
    assert_eq!(r.bytes, 3);
    assert!(r.stderr.contains("noise"), "stderr потерян: {}", r.stderr);
    assert_eq!(r.exit, 0);
    let _ = sess.disconnect().await;
}

/// Ненулевой код обязан доехать и здесь.
///
/// Прямой наследник бага с `Eof`: OpenSSH закрывает поток вывода раньше, чем
/// сообщает `exit-status`, и цикл, выходящий по `Eof`, вернул бы -1 при целом
/// прочитанном байте. Один байт stdout здесь нужен затем, чтобы `Eof` пришёл
/// после данных, а не вместо них.
#[tokio::test]
#[ignore = "requires docker ssh"]
async fn nonzero_exit_survives_the_eof_that_comes_before_it() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut sess = trusted_session(&kh, Duration::from_secs(30), Some(KEEPALIVE_INTERVAL)).await;

    let mut buf: Vec<u8> = Vec::new();
    let r = sess
        .exec_to_writer(
            "printf x; exit 7",
            Duration::from_secs(30),
            &mut buf,
            never_cancels,
        )
        .await
        .expect("stream");

    assert_eq!(r.exit, 7, "код возврата не доехал");
    assert_eq!(r.bytes, 1);
    assert_eq!(buf, b"x");
    let _ = sess.disconnect().await;
}

/// `idle_timeout` меряет тишину, а не длительность.
///
/// Пять секунд работы под полуторасекундным таймаутом обязаны пройти, потому
/// что пауза между кусками — секунда; ровно то, чего не умеет суммарный дедлайн
/// `exec`, на котором здоровая многочасовая выгрузка обрывалась бы на середине.
/// `/bin/echo` по полному пути, а не встроенный: отдельный процесс завершается
/// и тем гарантированно сбрасывает буфер, иначе шелл мог бы отдать все пять
/// кусков разом — и тест доказывал бы не то, что написано.
#[tokio::test]
#[ignore = "requires docker ssh"]
async fn idle_timeout_measures_silence_not_duration() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut sess = trusted_session(&kh, Duration::from_secs(60), Some(KEEPALIVE_INTERVAL)).await;

    let mut buf: Vec<u8> = Vec::new();
    let r = sess
        .exec_to_writer(
            "for i in 1 2 3 4 5; do /bin/echo x; sleep 1; done",
            Duration::from_millis(1500),
            &mut buf,
            never_cancels,
        )
        .await
        .expect("медленный, но говорящий поток обязан был дойти");
    assert_eq!(r.exit, 0);
    assert_eq!(r.bytes, 10, "пять раз по \"x\\n\"");

    // Та же граница, но тишина вместо кусков — обязана оборваться.
    let mut buf2: Vec<u8> = Vec::new();
    let e = sess
        .exec_to_writer(
            "sleep 5; printf x",
            Duration::from_millis(1500),
            &mut buf2,
            never_cancels,
        )
        .await
        .expect_err("замолчавший канал обязан был оборваться");
    assert!(
        matches!(&e, SshError::Session(m) if m.contains("idle")),
        "не тот класс ошибки: {e}"
    );
    // Не отмена: человек ничего не нажимал.
    assert!(!matches!(e, SshError::Cancelled { .. }));
    let _ = sess.disconnect().await;
}

/// Отмена останавливает выгрузку и НЕ роняет сессию.
///
/// Второе важнее первого: после отмены по этой же сессии идёт уборка (`rm -rf`
/// рабочего каталога), и если бы отмена рвала соединение, мусор оставался бы на
/// сервере ровно в том случае, когда мы точно знаем, что он не нужен.
#[tokio::test]
#[ignore = "requires docker ssh"]
async fn cancelling_stops_the_stream_and_leaves_the_session_usable() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut sess = trusted_session(&kh, Duration::from_secs(60), Some(KEEPALIVE_INTERVAL)).await;

    let mut buf: Vec<u8> = Vec::new();
    let e = sess
        .exec_to_writer("cat /dev/zero", Duration::from_secs(10), &mut buf, |n| {
            if n > 0 {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        })
        .await
        .expect_err("отмена обязана быть ошибкой, а не тихим успехом");

    match e {
        SshError::Cancelled { bytes } => assert!(bytes > 0, "отменили, не приняв ни байта"),
        other => panic!("не тот класс ошибки: {other}"),
    }

    let (code, out) = sess
        .exec("echo alive", Duration::from_secs(30), false)
        .await
        .expect("сессия обязана была пережить отмену");
    assert_eq!(code, 0);
    assert!(out.contains("alive"), "{out}");
    let _ = sess.disconnect().await;
}

/// Единственное доказательство keepalive: молчащая команда переживает
/// inactivity, который без keepalive её убивал.
///
/// Пара обязательна. Один зелёный прогон «с keepalive» ничего не значил бы —
/// он был бы таким же зелёным, окажись inactivity просто больше паузы; смысл
/// появляется только рядом с красным прогоном «без».
///
/// Числа маленькие (5 с inactivity, 12 с тишины, 2 с интервал) нарочно:
/// доказываемый механизм — «ответ сервера на keepalive сдвигает inactivity» —
/// от величины интервала не зависит, а с продуктовыми 30 с этот тест шёл бы
/// двумя минутами живого ожидания. Сами продуктовые числа держат юнит-тесты:
/// `keepalive_budget_is_the_interval_times_every_attempt` в `ssh::client` и
/// проверки соотношения у каждого session-таймаута в `commands/`.
#[tokio::test]
#[ignore = "requires docker ssh"]
async fn keepalive_carries_a_silent_command_past_the_inactivity_timeout() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let inactivity = Duration::from_secs(5);
    let silent = "sleep 12; printf done";

    let mut without = trusted_session(&kh, inactivity, None).await;
    let mut buf: Vec<u8> = Vec::new();
    let e = without
        .exec_to_writer(silent, Duration::from_secs(60), &mut buf, never_cancels)
        .await;
    // Именно `Disconnected`, а не «хоть какая-нибудь ошибка»: первая редакция
    // возвращала здесь `Ok(exit: -1)` — обрыв связи был неотличим от нормально
    // закрытого потока, и тест на keepalive падал не потому, что keepalive не
    // работает, а потому, что смерть сессии не считалась смертью.
    match e {
        Err(SshError::Disconnected { bytes }) => assert_eq!(bytes, 0, "команда молчала"),
        Ok(r) => panic!("обрыв сессии вернулся как успех: {r:?}"),
        Err(other) => panic!("не тот класс ошибки: {other}"),
    }

    let mut with = trusted_session(&kh, inactivity, Some(Duration::from_secs(2))).await;
    let mut buf2: Vec<u8> = Vec::new();
    let r = with
        .exec_to_writer(silent, Duration::from_secs(60), &mut buf2, never_cancels)
        .await
        .expect("с keepalive та же команда обязана была дойти");
    assert_eq!(r.exit, 0);
    assert_eq!(buf2, b"done");
    let _ = with.disconnect().await;
}

// ---- фаза 2: замок и маркер конвейера ---------------------------------------
//
// Оба теста живут здесь, а не в юнитах, потому что доказывают поведение ЧУЖОЙ
// стороны: юнит-тест видит собранную строку, а не то, что с ней сделает
// настоящий шелл настоящего сервера. Всё, что требует FastPanel или mysql
// (`sites list`, `mysqldump`), сюда не переносится — на голом openssh такой
// тест доказывал бы только то, что команды нет.

/// `mkdir` каталога на POSIX атомарен: второй раз он ОБЯЗАН упасть.
///
/// На этом стоит весь серверный слой идемпотентности бэкапа, и проверить это
/// можно только на живой ФС: юнит-тест увидел бы лишь текст команды. Заодно
/// проверяются `stat -c %Y` и `date +%s` — их вывод разбирает `parse_lock_probe`,
/// а форма у них платформенная.
#[tokio::test]
#[ignore = "requires docker ssh on SDMP_SSH_TEST_HOST:SDMP_SSH_TEST_PORT"]
async fn a_backup_lock_directory_cannot_be_taken_twice() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut s = trusted_session(&kh, Duration::from_secs(30), Some(KEEPALIVE_INTERVAL)).await;

    let root = "/var/tmp/sdmp-backup-it";
    let work = "/var/tmp/sdmp-backup-it/lock.example";
    // Хвост прошлого прогона убираем ДО теста: замок, оставшийся с прошлого
    // раза, сделал бы зелёным даже сломанный `mkdir`.
    let _ = s
        .exec(&build_cleanup_cmd(root, None), Duration::from_secs(30), false)
        .await
        .unwrap();

    let (first, _) = s
        .exec(&build_lock_cmd(root, work), Duration::from_secs(30), false)
        .await
        .unwrap();
    assert_eq!(first, 0, "первый замок обязан взяться");

    let (second, _) = s
        .exec(&build_lock_cmd(root, work), Duration::from_secs(30), false)
        .await
        .unwrap();
    assert_ne!(second, 0, "второй `mkdir` обязан упасть — иначе замок не замок");

    let (_, probe) = s
        .exec(&build_lock_probe_cmd(work), Duration::from_secs(30), false)
        .await
        .unwrap();
    let age = parse_lock_probe(&probe)
        .unwrap_or_else(|| panic!("проба замка не разобралась: {probe:?}"))
        .expect("каталог существует, возраст обязан быть");
    assert!((0..60).contains(&age), "возраст замка вне здравого смысла: {age}");

    // Уборка снимает замок — и следующий прогон снова его берёт.
    let (rm, _) = s
        .exec(&build_cleanup_cmd(work, None), Duration::from_secs(30), false)
        .await
        .unwrap();
    assert_eq!(rm, 0);
    let (third, _) = s
        .exec(&build_lock_cmd(root, work), Duration::from_secs(30), false)
        .await
        .unwrap();
    assert_eq!(third, 0, "после уборки замок обязан браться снова");

    let _ = s
        .exec(&build_cleanup_cmd(root, None), Duration::from_secs(30), false)
        .await
        .unwrap();
    let _ = s.disconnect().await;
}

/// Коды ВСЕХ звеньев конвейера доезжают через настоящий exec-канал.
///
/// Это то самое место, где «`tar` вернул 1, `gzip` отработал» отличается от
/// «`tar` отработал, `gzip` упал»: без `PIPESTATUS` оба конца выглядят кодом 1,
/// а первый у нас предупреждение, второй — отказ с обрезанным архивом. Сам
/// `tar` здесь не зовётся намеренно: у busybox нет `--warning=no-file-changed`,
/// и тест падал бы по причине, которой на целевых серверах (GNU tar) нет.
#[tokio::test]
#[ignore = "requires docker ssh on SDMP_SSH_TEST_HOST:SDMP_SSH_TEST_PORT"]
async fn the_pipeline_marker_survives_a_real_login_shell() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut s = trusted_session(&kh, Duration::from_secs(30), Some(KEEPALIVE_INTERVAL)).await;

    let cmd = format!("set -o pipefail; (exit 3) | cat; {PIPE_STATUS_TAIL}");
    let (_, out) = s.exec(&cmd, Duration::from_secs(30), false).await.unwrap();
    assert_eq!(
        parse_pipeline_status(&out),
        Some(vec![3, 0]),
        "маркер не доехал или разобрался неверно: {out:?}"
    );

    // И обратный случай: упало ВТОРОЕ звено, первое цело.
    //
    // Читатель обязан ДОЧИТАТЬ (`cat >/dev/null`), и это не украшение: с голым
    // `printf x | (exit 5)` тест флачит примерно раз на триста прогонов (2000
    // прогонов в контейнере дали 7 штук `141 5`). Гонка честная — читатель
    // выходит, не читая, и `printf` то успевает в буфер трубы, то ловит
    // SIGPIPE, — но живёт она в ТЕСТЕ, а не в продукте, и узаконивать её
    // ожиданием «0 либо 141» значит превращать доказательство в допущение.
    //
    // Продукту 141 в первой позиции не страшен по построению: `tar` получает
    // SIGPIPE, только если умер `gzip`, а тогда у `gzip` собственный код ≠ 0 —
    // и `classify_tar_status` смотрит его ПЕРВЫМ, отдавая `Failed`. Даже
    // окажись 141 первым при `gzip == 0`, его ловит ветка «≥ 2 — отказ».
    let cmd = format!("set -o pipefail; printf x | (cat >/dev/null; exit 5); {PIPE_STATUS_TAIL}");
    let (_, out) = s.exec(&cmd, Duration::from_secs(30), false).await.unwrap();
    assert_eq!(parse_pipeline_status(&out), Some(vec![0, 5]), "{out:?}");

    let _ = s.disconnect().await;
}

// --- фаза 4: выгрузка архива на диск ----------------------------------------

/// Настоящий поток гигабайтной формы (уменьшенный): файл на сервере →
/// `download_archive` → файл под настоящим именем.
///
/// Доказывает три вещи, которых юнит-тест доказать не может, потому что все три
/// живут на стыке сети и диска: `HashingWriter` считает хеш ТОГО, что записано
/// (сверка идёт с sha256, посчитанным самим сервером, а не нами); `.part`
/// исчезает; под настоящим именем лежит ровно то, что было на сервере.
#[tokio::test]
#[ignore = "requires docker ssh on SDMP_SSH_TEST_HOST:SDMP_SSH_TEST_PORT"]
async fn a_downloaded_archive_gets_its_real_name_only_after_the_server_checksum_matches() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut s = trusted_session(&kh, Duration::from_secs(60), Some(KEEPALIVE_INTERVAL)).await;

    // 3 МБ случайных байт: заведомо больше одного чанка (32 KiB), то есть
    // частичные записи и многократный `poll_write` — настоящие.
    let remote = "/tmp/sdmp-download-test.bin";
    let make = format!("head -c 3000000 /dev/urandom > {remote}; sha256sum {remote}; stat -c %s {remote}");
    let (code, out) = s.exec(&make, Duration::from_secs(60), false).await.unwrap();
    assert_eq!(code, 0, "{out}");
    let mut lines = out.split_whitespace();
    let server_sha = lines.next().unwrap().to_string();
    let _path = lines.next();
    let server_bytes: u64 = lines.next().unwrap().parse().unwrap();
    assert_eq!(server_bytes, 3_000_000);

    let dest = tmp.path().join("archive.tar");
    let part = part_path(&dest);
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let seen_c = seen.clone();
    let got = download_archive(
        &mut s,
        remote,
        &dest,
        &server_sha,
        server_bytes,
        Duration::from_secs(30),
        move |done| {
            seen_c.store(done, std::sync::atomic::Ordering::SeqCst);
            ControlFlow::Continue(())
        },
    )
    .await
    .expect("выгрузка");

    assert_eq!(got.bytes, server_bytes);
    assert_eq!(got.sha256, server_sha, "хеш считался не по тому, что записано");
    assert!(dest.exists(), "файла под настоящим именем нет");
    assert!(!part.exists(), "огрызок `.part` остался на диске");
    assert_eq!(std::fs::metadata(&dest).unwrap().len(), server_bytes);
    // Хеш файла НА ДИСКЕ, посчитанный заново, — последняя точка доверия.
    let on_disk = std::fs::read(&dest).unwrap();
    assert_eq!(hex::encode(Sha256::digest(&on_disk)), server_sha);
    // Прогресс доезжал: без этого троттлинг фазы 4 показывал бы пустую строку.
    assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), server_bytes);

    let _ = s.exec(&format!("rm -f {remote}"), Duration::from_secs(30), false).await;
    let _ = s.disconnect().await;
}

/// Не сошёлся хеш — на диске не остаётся НИЧЕГО похожего на архив.
///
/// Ради этого правила `.part` и существует: файл с правильным именем и
/// расширением, но битым содержимым, выглядит рабочим архивом, и узнают об
/// этом в момент восстановления, то есть в худший из возможных.
#[tokio::test]
#[ignore = "requires docker ssh on SDMP_SSH_TEST_HOST:SDMP_SSH_TEST_PORT"]
async fn a_checksum_that_does_not_match_leaves_no_file_at_all() {
    let tmp = tempfile::tempdir().unwrap();
    let kh = tmp.path().join("known_hosts");
    let mut s = trusted_session(&kh, Duration::from_secs(60), Some(KEEPALIVE_INTERVAL)).await;

    let remote = "/tmp/sdmp-download-bad.bin";
    let (code, out) = s
        .exec(
            &format!("head -c 100000 /dev/urandom > {remote}"),
            Duration::from_secs(60),
            false,
        )
        .await
        .unwrap();
    assert_eq!(code, 0, "{out}");

    let dest = tmp.path().join("archive.tar");
    let wrong = "0".repeat(64);
    let err = download_archive(
        &mut s,
        remote,
        &dest,
        &wrong,
        100_000,
        Duration::from_secs(30),
        never_cancels,
    )
    .await
    .expect_err("битый хеш обязан быть отказом");
    assert!(
        matches!(err, DownloadError::ChecksumMismatch { .. }),
        "{err}"
    );
    assert!(!dest.exists(), "битый файл лёг под настоящим именем");
    assert!(!part_path(&dest).exists(), "огрызок `.part` остался");

    // И размер: сервер насчитал больше, чем есть, — тоже отказ и тоже пусто.
    let (real_sha, _) = {
        let (_, out) = s
            .exec(&format!("sha256sum {remote}"), Duration::from_secs(30), false)
            .await
            .unwrap();
        let sha = out.split_whitespace().next().unwrap().to_string();
        (sha, ())
    };
    let err = download_archive(
        &mut s,
        remote,
        &dest,
        &real_sha,
        100_001,
        Duration::from_secs(30),
        never_cancels,
    )
    .await
    .expect_err("недоехавший размер обязан быть отказом");
    assert!(matches!(err, DownloadError::SizeMismatch { .. }), "{err}");
    assert!(!dest.exists());
    assert!(!part_path(&dest).exists());

    let _ = s.exec(&format!("rm -f {remote}"), Duration::from_secs(30), false).await;
    let _ = s.disconnect().await;
}
