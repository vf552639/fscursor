//! Чтение ХВОСТА лог-файла сайта по SSH — по требованию, а не снимком.
//!
//! Отдельный файл, а не дописка в `fastpanel_facts.rs`, по той же причине, по
//! какой сам `fastpanel_facts.rs` отделён от `fastpanel.rs`: тот про **снимок**,
//! который уезжает на сервер и ложится в открытую JSON-колонку `domains.fp_facts`,
//! а этот — про чтение по требованию, которое не уезжает НИКУДА. Разная цена
//! ошибки: в access-логе лежат чужие IP, URL с query string и user-agent, то есть
//! персональные данные третьих лиц. Смешать два правила в одном файле — значит
//! однажды по невнимательности дописать хвост во write-back.
//!
//! Панельный CLI логи не отдаёт (разведка 2026-08-19 по базе знаний вендора:
//! ни команды, ни флага), поэтому читаем файл напрямую — как уже читаем SSL
//! через `openssl` и раскладку через `test -f`.
//!
//! Пароля в argv этих команд нет и быть не может: мы только читаем чужую машину,
//! ничего не создавая. Отсюда и отличие от `fastpanel.rs`: `opaque_exit` здесь не
//! нужен, текст ошибки можно отдавать наружу целиком — но наружу означает ТОЛЬКО
//! в десктоп.

use std::time::Duration;

use serde::Serialize;

use crate::ssh::client::SshError;
use crate::ssh::fastpanel::{q, Exec};

/// Байтовый потолок на одно чтение. Стоит ПЕРВЫМ в конвейере: `tail -n` по логу
/// в гигабайты прочитал бы файл целиком, а так читается фиксированный хвост.
pub const LOG_TAIL_BYTES: u64 = 256 * 1024;

/// Сколько строк показываем. 200 — экран прокрутки, а не «немного»: меньше не
/// покрывает всплеск ошибок, больше не читается глазами и не помогает.
pub const LOG_TAIL_LINES: usize = 200;

/// Предел на exec чтения хвоста. Меньше `FACTS_EXEC_TIMEOUT` (45 c) намеренно:
/// здесь одна команда над одним файлом, а не листинг сотни доменов и `openssl`
/// поверх цепочки. Публичный, потому что задаёт нижнюю границу для inactivity
/// сессии (`LOG_TAIL_SESSION_TIMEOUT` в `commands::domain_logs`) — связь
/// закреплена тестом там же.
pub const LOG_TAIL_EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// Маркер «файла нет» — отдельное состояние, а не пустой хвост (принцип №6:
/// незнание не рисуем здоровьем).
const MARK_MISSING: &str = "#sdmp:missing";
/// Префикс маркера размера; за ним число байт.
const MARK_SIZE: &str = "#sdmp:size ";
/// Дальше идут строки самого лога и больше ничего: после него разбор маркеров
/// прекращается, иначе строка лога, начинающаяся с `#sdmp:`, была бы съедена.
const MARK_TAIL: &str = "#sdmp:tail";
/// Подпись «вывод доехал целиком» — как `#sdmp:end` у метрик сервера. Без неё
/// оборванный посреди строки вывод выглядел бы просто коротким логом.
const MARK_END: &str = "#sdmp:end";

/// Хвост одного лог-файла, каким он приехал с сервера.
///
/// `Serialize` — уходит ТОЛЬКО в UI десктопа. На сервер этот тип не уезжает ни
/// в каком виде: ни во write-back снимка, ни в аудит, ни в SQLCipher-кэш. В
/// access-логе стоят чужие персональные данные, а `domains.fp_facts` — открытая
/// колонка в Postgres; единственное место, где строки лога живут, — память
/// десктопа.
///
/// `size_bytes` намеренно БЕЗ `skip_serializing_if` (в отличие от одноимённого
/// поля `LogFile` в снимке): фронт ждёт `number | null`, и «поля нет» и «размер
/// неизвестен» там разными состояниями не различаются — пусть поле всегда стоит
/// на проводе.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct LogTail {
    pub exists: bool,
    pub size_bytes: Option<u64>,
    pub lines: Vec<String>,
    /// Кап сработал: показано не с начала файла.
    pub truncated: bool,
}

/// Команда «размер файла и его хвост» с маркерами по образцу
/// `COLLECT_METRICS_COMMAND` во фронте.
///
/// Порядок в конвейере не косметический: `tail -c` стоит ПЕРЕД `tail -n`, потому
/// что байтовый кап — единственное, что ограничивает объём чтения. Поставь их
/// наоборот, и `tail -n 200` по логу на 2 ГБ прочитал бы весь файл, прежде чем
/// отдать двести строк.
///
/// Размер снимается заново, а не берётся из снимка: он и есть ответ на вопрос
/// «сработал ли кап», и он свежий, тогда как снимок бывает недельной давности.
///
/// Путь обязан пройти через `q()` (`shell_escape`) — правило §7.2
/// `docs/FASTPANEL_CLI.md`: прямой интерполяции пути в шелл быть не должно.
/// Числа подставляются из констант, а не литералами: иначе правка константы
/// молча разошлась бы с командой (закреплено тестом).
pub fn build_log_tail_cmd(path: &str) -> String {
    let p = q(path);
    format!(
        "if [ ! -f {p} ]; then echo '{MARK_MISSING}'; \
         else printf '{MARK_SIZE}%s\\n' \"$(stat -c %s {p})\"; \
         echo '{MARK_TAIL}'; \
         tail -c {bytes} {p} | tail -n {lines}; fi; \
         echo '{MARK_END}'",
        p = p,
        bytes = LOG_TAIL_BYTES,
        lines = LOG_TAIL_LINES,
    )
}

/// Разбор вывода `build_log_tail_cmd`. Чистая функция — вся логика решений тут,
/// а не в `read_log_tail`, где её нельзя проверить без живого сервера.
///
/// Нет `#sdmp:end` → `None`: разбор отказывает ЦЕЛИКОМ, как у метрик. Спасать
/// неполный вывод нельзя — лог, оборванный таймаутом посреди строки, выглядел бы
/// как короткий лог, то есть как исправное чтение.
///
/// `#sdmp:end` ищется с КОНЦА: строка самого лога может содержать что угодно, в
/// том числе наши маркеры, а наш `echo` заведомо последний. По той же причине
/// после `#sdmp:tail` маркеры больше не разбираются — всё, что идёт за ним,
/// содержимое файла и ничего больше.
///
/// `cap` — тот самый байтовый потолок: `size > cap` значит, что `tail -c` резал,
/// и первая строка почти наверняка обрезок. Обрезок первой строки — не строка,
/// поэтому его выбрасываем (в error-логе одна запись PHP-трейса бывает в сотни
/// мегабайт: её хвост без начала — не запись, а мусор).
pub fn parse_log_tail(output: &str, cap: u64) -> Option<LogTail> {
    let all: Vec<&str> = output.lines().collect();
    let end = all.iter().rposition(|l| *l == MARK_END)?;

    let mut missing = false;
    let mut size_bytes: Option<u64> = None;
    let mut lines: Vec<String> = Vec::new();
    let mut in_tail = false;
    for line in &all[..end] {
        if in_tail {
            lines.push((*line).to_string());
            continue;
        }
        if *line == MARK_MISSING {
            missing = true;
        } else if let Some(rest) = line.strip_prefix(MARK_SIZE) {
            size_bytes = rest.trim().parse::<u64>().ok();
        } else if *line == MARK_TAIL {
            in_tail = true;
        }
        // Всё прочее до `#sdmp:tail` — не наше (баннер шелла, motd): молча мимо.
    }

    if missing {
        return Some(LogTail {
            exists: false,
            size_bytes: None,
            lines: Vec::new(),
            truncated: false,
        });
    }

    let truncated = size_bytes.is_some_and(|s| s > cap);
    if truncated && !lines.is_empty() {
        lines.remove(0);
    }
    Some(LogTail {
        exists: true,
        size_bytes,
        lines,
        truncated,
    })
}

/// Прочитать хвост одного лог-файла одной командой.
///
/// Код возврата не смотрим: и ветка «файла нет», и ветка чтения завершаются
/// успешно, а всё, что нас интересует, сказано маркерами. Непонятный вывод — это
/// отказ, а не пустой хвост: пустой хвост означал бы «в логе ничего нет», чего мы
/// не знаем.
///
/// Путь сюда обязан приходить уже проверенным по снимку домена (гейт в
/// `commands::domain_logs`) — этот слой про транспорт, а не про полномочия.
pub async fn read_log_tail(s: &mut impl Exec, path: &str) -> Result<LogTail, SshError> {
    let cmd = build_log_tail_cmd(path);
    let (_, out) = s.run(&cmd, LOG_TAIL_EXEC_TIMEOUT).await?;
    parse_log_tail(&out, LOG_TAIL_BYTES)
        .ok_or_else(|| SshError::Session("unparsable log tail output".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;

    /// Всё, что стоит ВНЕ одинарных кавычек собранной команды. Кавычки в этой
    /// команде бывают только двух родов — наши маркеры и результат `q()`, —
    /// поэтому «нечётные куски» разбиения и есть закавыченное.
    fn outside_quotes(cmd: &str) -> String {
        cmd.split('\'')
            .step_by(2)
            .collect::<Vec<_>>()
            .join(" ")
    }

    // Путь приходит из снимка, но снимок снят с чужой машины: имя файла на ней
    // могло быть каким угодно. Проверяем ЭФФЕКТ квотирования — что инъекция
    // осталась внутри кавычек, а не то, как выглядит строка.
    #[test]
    fn build_log_tail_cmd_quotes_the_path() {
        let cmd = build_log_tail_cmd("/tmp/a; rm -rf /");
        assert!(
            cmd.contains("'/tmp/a; rm -rf /'"),
            "путь не закавычен целиком: {cmd}"
        );
        let bare = outside_quotes(&cmd);
        assert!(!bare.contains("rm -rf"), "инъекция вылезла из кавычек: {bare}");
        assert!(!bare.contains("/tmp/a"), "часть пути вне кавычек: {bare}");
    }

    // Константы обязаны стоять в тексте команды: иначе правка `LOG_TAIL_BYTES`
    // молча разошлась бы с тем, что реально уходит на сервер.
    #[test]
    fn build_log_tail_cmd_uses_the_constants() {
        let cmd = build_log_tail_cmd("/var/www/u/data/logs/a.log");
        assert!(
            cmd.contains(&format!("tail -c {LOG_TAIL_BYTES} ")),
            "байтовый кап не из константы: {cmd}"
        );
        assert!(
            cmd.contains(&format!("tail -n {LOG_TAIL_LINES}")),
            "число строк не из константы: {cmd}"
        );
        // Байтовый кап — раньше строкового, иначе `tail -n` прочитает файл целиком.
        let by_bytes = cmd.find("tail -c").expect("нет байтового капа");
        let by_lines = cmd.find("tail -n").expect("нет строкового капа");
        assert!(by_bytes < by_lines, "кап по байтам обязан идти первым: {cmd}");
    }

    const NORMAL: &str = "#sdmp:size 1024\n#sdmp:tail\nfirst line\nsecond line\n#sdmp:end\n";

    #[test]
    fn parse_log_tail_reads_a_normal_output() {
        let t = parse_log_tail(NORMAL, LOG_TAIL_BYTES).unwrap();
        assert!(t.exists);
        assert_eq!(t.size_bytes, Some(1024));
        assert_eq!(t.lines, vec!["first line".to_string(), "second line".to_string()]);
        assert!(!t.truncated);
    }

    #[test]
    fn parse_log_tail_reads_missing_file() {
        let t = parse_log_tail("#sdmp:missing\n#sdmp:end\n", LOG_TAIL_BYTES).unwrap();
        assert!(!t.exists);
        assert_eq!(t.size_bytes, None);
        assert!(t.lines.is_empty());
        assert!(!t.truncated);
    }

    // Без подписи разбор отказывает целиком: оборванный вывод неотличим от
    // короткого лога, а показать его как лог — значит соврать.
    #[test]
    fn parse_log_tail_rejects_output_without_the_end_marker() {
        assert!(parse_log_tail("#sdmp:size 10\n#sdmp:tail\nline\n", LOG_TAIL_BYTES).is_none());
        assert!(parse_log_tail("", LOG_TAIL_BYTES).is_none());
    }

    // Файл больше капа: показано не с начала, и первая строка — обрезок.
    #[test]
    fn parse_log_tail_drops_the_first_line_when_capped() {
        let out = "#sdmp:size 999999999\n#sdmp:tail\n-cut-tail-of-a-line\nwhole line\n#sdmp:end\n";
        let t = parse_log_tail(out, LOG_TAIL_BYTES).unwrap();
        assert!(t.truncated);
        assert_eq!(t.lines, vec!["whole line".to_string()]);
    }

    // Пустой файл — это НЕ «файла нет»: 0 B и ноль строк, но `exists: true`.
    // Разные причины пустоты экрана требуют разных слов на экране.
    #[test]
    fn parse_log_tail_tells_an_empty_file_from_a_missing_one() {
        let t = parse_log_tail("#sdmp:size 0\n#sdmp:tail\n#sdmp:end\n", LOG_TAIL_BYTES).unwrap();
        assert!(t.exists);
        assert_eq!(t.size_bytes, Some(0));
        assert!(t.lines.is_empty());
        assert!(!t.truncated);
    }

    // Строка лога вправе выглядеть как наш маркер (в error-логе бывает что
    // угодно). После `#sdmp:tail` маркеры не разбираются, а подпись ищется с
    // конца — поэтому такая строка приезжает как строка.
    #[test]
    fn parse_log_tail_keeps_marker_lookalikes_inside_the_log() {
        let out = "#sdmp:size 5\n#sdmp:tail\n#sdmp:end\n#sdmp:missing\n#sdmp:end\n";
        let t = parse_log_tail(out, LOG_TAIL_BYTES).unwrap();
        assert!(t.exists);
        assert_eq!(
            t.lines,
            vec!["#sdmp:end".to_string(), "#sdmp:missing".to_string()]
        );
    }

    // ---- сервер под расписанный ответ (эффект, а не текст команды) ----------

    struct FakeServer {
        reply: (i32, String),
        seen: Vec<String>,
    }

    #[async_trait]
    impl Exec for FakeServer {
        async fn run(&mut self, cmd: &str, _t: Duration) -> Result<(i32, String), SshError> {
            self.seen.push(cmd.to_string());
            Ok(self.reply.clone())
        }
    }

    #[tokio::test]
    async fn read_log_tail_does_one_exec_without_secrets() {
        let mut s = FakeServer {
            reply: (0, NORMAL.to_string()),
            seen: Vec::new(),
        };
        let t = read_log_tail(&mut s, "/var/www/u/data/logs/a.log").await.unwrap();
        assert_eq!(t.lines.len(), 2);
        assert_eq!(s.seen.len(), 1, "хвост читается одной командой");
        let cmd = &s.seen[0];
        assert!(!cmd.contains("password"), "секрет в argv чтения: {cmd}");
        assert!(!cmd.contains("--password"), "секрет в argv чтения: {cmd}");
    }

    // Непонятный вывод — отказ, а не пустой хвост: «в логе ничего нет» мы в этот
    // момент не знаем.
    #[tokio::test]
    async fn read_log_tail_fails_on_unparsable_output() {
        let mut s = FakeServer {
            reply: (0, "bash: stat: command not found\n".to_string()),
            seen: Vec::new(),
        };
        let e = read_log_tail(&mut s, "/var/www/u/data/logs/a.log").await.unwrap_err();
        assert!(e.to_string().contains("unparsable log tail output"), "{e}");
    }
}
