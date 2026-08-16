#!/usr/bin/env bash
#
# fastpanel-discovery.sh — разведка FastPanel CLI на живом сервере.
#
# Зачем: продукт умеет ПИСАТЬ в панель (`sites create`, `ftp_account create`,
# `database create`, `certificates create-le` — `desktop/src-tauri/src/ssh/fastpanel.rs`),
# но не умеет ЧИТАТЬ, потому что форма вывода читающих команд не сверена ни разу.
# Скрипт снимает эту форму с живого сервера одним прогоном, чтобы по его выводу
# написать `docs/FASTPANEL_CLI.md` и парсеры (фаза 0 плана
# `plans/2026-08-16-fastpanel-cli-chtenie-domena.md`).
#
# ТОЛЬКО ЧТЕНИЕ. Ни одна команда здесь ничего не создаёт, не меняет и не удаляет:
# `--help`, `list`, `test`, `ls`, `find`, `cat`, `grep`. Скрипт идёт на живой
# продакшн, и это требование жёстче любого удобства — новую команду сюда можно
# добавлять только убедившись, что она читающая.
#
# Разметка вывода скопирована с `COLLECT_METRICS_COMMAND`
# (`frontend/src/lib/serverMetrics.ts`) и по той же причине: вывод едет с ЧУЖОЙ
# машины, где половина команд может не существовать, а поверх stdout может
# приехать баннер SSH. Без маркеров вывод пришлось бы разрезать угадыванием формы
# — то есть ровно тем, от чего мы уходим. Формат:
#
#   #sdmp:section <имя>     начало секции
#   #sdmp:cmd <argv>        что именно запущено
#   <вывод команды, stdout и stderr вместе>
#   #sdmp:exit <код>        код возврата — он тоже результат разведки
#   #sdmp:skip <причина>    секция не запускалась (вместо cmd/exit)
#   #sdmp:note <текст>      пояснение разведчика, не вывод команды
#   #sdmp:end               вывод доехал целиком
#
# Всё до первого маркера — предупреждение оператору и SSH-баннер, не данные.
#
# Использование:
#   bash scripts/fastpanel-discovery.sh [домен] > discovery.txt 2>&1
#
# Домен нужен доменно-зависимым секциям (конфиги nginx/apache, логи). Если не
# передан — берётся первый сайт с сервера, а если и его нет, секции честно
# помечаются пропущенными.

# `set -e` здесь запрещён намеренно: несуществующая подкоманда — это тоже
# результат разведки, и падать на ней значило бы терять весь оставшийся прогон
# ради строчки «exit 2». Каждая секция выполняется независимо, её код возврата
# уходит в вывод. `set -u` оставлен: он ловит опечатку в имени переменной, а не
# чужой отказ.
set -u

# --- Константы -------------------------------------------------------------

# Префикс маркера — тот же, что в `COLLECT_METRICS_COMMAND`.
readonly MARK='#sdmp:'

# Потолок на одну команду. Спасает от подкоманды, которая вместо usage ушла
# ждать ввод: stdin у всех команд закрыт (`</dev/null`), но у панели свой CLI и
# гарантий на этот счёт нет, а прогон идёт на продакшне.
readonly CMD_TIMEOUT=60

# Потолок на длину перечислений (`find`, `ls` по каталогу со всеми сайтами):
# на сервере с сотнями доменов эти секции — единственные, что растут без предела.
readonly MAX_LIST_LINES=200

# Сколько конфигов на домен собираем. Их в норме один-два (nginx + apache);
# больше — это уже совпадение по префиксу имени, и читать их все незачем.
readonly MAX_SITE_CONFIGS=5

# Тот же запасной путь, что в `fastpanel.rs` (`FASTPANEL_FALLBACK_PATH`).
readonly FASTPANEL_FALLBACK_PATH='/usr/local/fastpanel2/fastpanel'

# Корень сайтов FastPanel. Отсюда берутся домен (когда его не передали),
# владелец сайта и путь логов; та же раскладка зашита в `site_path_re`
# (`fastpanel.rs`), и разъехаться они не должны.
readonly WWW_ROOT='/var/www'

readonly NGINX_SITES_DIR='/etc/nginx/fastpanel2-sites'
readonly APACHE_SITES_DIR='/etc/apache2/fastpanel2-sites'

# --- Состояние прогона -----------------------------------------------------

LAST_OUT=''        # вывод последней секции — из него достаётся путь к бинарю и домен
LAST_CODE=1        # её код возврата
FP_BIN=''          # найденный fastpanel; пусто — все его секции пропускаются
DOMAIN=''          # домен доменно-зависимых секций
DOMAIN_SOURCE=''   # откуда он взялся: важно при чтении вывода
SITE_USER=''       # владелец сайта из раскладки /var/www/<user>/data/www/<domain>
SITE_PATH=''
CONF_FILES=()      # найденные конфиги сайта — по ним ищется раскладка логов

# `timeout` есть не везде; отсутствие не повод отменять разведку.
TIMEOUT_BIN="$(command -v timeout 2>/dev/null || true)"

# --- Вывод -----------------------------------------------------------------

section() { printf '%ssection %s\n' "$MARK" "$1"; }
note()    { printf '%snote %s\n' "$MARK" "$1"; }

# Показать argv одной строкой так, чтобы её можно было повторить руками.
#
# Простые аргументы печатаются как есть — иначе строка `#sdmp:cmd` в
# документации утонула бы в экранировании. Всё, где есть символ со значением для
# шелла, проходит через `printf %q`: без этого шаблон `access_log|error_log`
# выглядел бы в выводе конвейером, которым он не является.
fmt_argv() {
  local out='' arg
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9._/=:+,@%-]+$ ]]; then
      out+="$arg "
    else
      out+="$(printf '%q' "$arg") "
    fi
  done
  printf '%s' "${out% }"
}

# Секция, которую не запускали. Пропуск — такой же результат, как код возврата:
# «команды нет» и «команда отказала» — разные факты, и путать их нельзя.
skip_section() {
  section "$1"
  printf '%sskip %s\n' "$MARK" "$2"
  printf '\n'
}

# Запустить команду как argv (без шелла) и записать секцию.
#
# argv, а не строка: разведка ходит по путям с именем домена внутри, и склейка
# строки означала бы квотирование на каждом шаге. Побочный результат остаётся в
# `LAST_OUT`/`LAST_CODE` — их читают резолверы бинаря и домена, чтобы не гонять
# одну и ту же команду дважды.
run() {
  local name="$1"
  shift
  section "$name"
  printf '%scmd %s\n' "$MARK" "$(fmt_argv "$@")"
  if [ -n "$TIMEOUT_BIN" ]; then
    LAST_OUT="$("$TIMEOUT_BIN" "$CMD_TIMEOUT" "$@" </dev/null 2>&1)"
  else
    LAST_OUT="$("$@" </dev/null 2>&1)"
  fi
  LAST_CODE=$?
  if [ -n "$LAST_OUT" ]; then printf '%s\n' "$LAST_OUT"; fi
  printf '%sexit %s\n' "$MARK" "$LAST_CODE"
  printf '\n'
  return 0
}

# То же, но через шелл — только там, где нужны конвейер или glob. Строка
# собирается из констант этого файла; единственное, что приезжает в неё извне —
# путь к логам, и он проходит через `printf %q` на месте сборки.
run_sh() {
  local name="$1" cmd="$2"
  section "$name"
  printf '%scmd %s\n' "$MARK" "$cmd"
  if [ -n "$TIMEOUT_BIN" ]; then
    LAST_OUT="$("$TIMEOUT_BIN" "$CMD_TIMEOUT" bash -c "$cmd" </dev/null 2>&1)"
  else
    LAST_OUT="$(bash -c "$cmd" </dev/null 2>&1)"
  fi
  LAST_CODE=$?
  if [ -n "$LAST_OUT" ]; then printf '%s\n' "$LAST_OUT"; fi
  printf '%sexit %s\n' "$MARK" "$LAST_CODE"
  printf '\n'
  return 0
}

# Секция команды FastPanel. Нет бинаря — нет секции, но она всё равно помечена:
# «панели не нашлось» и «панель ответила отказом» читаются по-разному.
fp() {
  local name="$1"
  shift
  if [ -z "$FP_BIN" ]; then
    skip_section "$name" "бинарь fastpanel не найден"
    return 0
  fi
  run "$name" "$FP_BIN" "$@"
}

# --- Аргументы -------------------------------------------------------------

usage() {
  cat <<'USAGE'
Использование: bash scripts/fastpanel-discovery.sh [домен] > discovery.txt 2>&1

  домен   для секций с конфигами nginx/apache и раскладкой логов.
          Не передан — берётся первый сайт с сервера.

Скрипт только читает: --help, list, test, ls, find, cat, grep. Запускать от root.
USAGE
}

DOMAIN_ARG="${1:-}"
case "$DOMAIN_ARG" in
  -h|--help)
    usage
    exit 0
    ;;
esac

# Домен приезжает из рук оператора и дальше идёт в пути и в аргументы `find`.
# Проверка формы — не косметика: `../` или `*` в этом месте увели бы разведку
# читать чужие каталоги.
if [ -n "$DOMAIN_ARG" ] && ! [[ "$DOMAIN_ARG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'Аргумент «%s» не похож на домен: допустимы буквы, цифры, точка, дефис, подчёркивание.\n' \
    "$DOMAIN_ARG" >&2
  exit 2
fi

# --- Предупреждение оператору ----------------------------------------------

# Идёт ДО первого маркера, то есть в область «не данные», и повторяется в stderr,
# когда stdout перенаправлен в файл: иначе оператор, запускающий скрипт с `>`,
# предупреждения на экране вообще не увидит.
warning() {
  cat <<'WARN'
=============================================================================
 fastpanel-discovery.sh — РАЗВЕДКА FastPanel CLI. ТОЛЬКО ЧТЕНИЕ.
 Ни одна команда ниже ничего не создаёт, не меняет и не удаляет.

 В выводе БУДУТ: имена доменов, системные логины (владельцы сайтов, FTP-логины),
 имена баз, пути к файлам и конфиги nginx/apache.
 Паролей мы не собираем: команды с паролем в argv не запускаются, файлы
 приложений (wp-config.php и подобные) и пулы php-fpm не читаются вовсе.

 ПРОСМОТРИТЕ вывод перед тем, как куда-то его отправлять: форма ответов панели
 нам как раз и неизвестна — за тем и разведка.
 Запускать от root — иначе большая часть секций упрётся в права.
=============================================================================
WARN
}

warning
if [ ! -t 1 ]; then warning >&2; fi

# --- Окружение -------------------------------------------------------------

run 'env-date' date -u '+%Y-%m-%dT%H:%M:%SZ'
run 'env-host' hostname
run 'env-user' id -un
run 'env-kernel' uname -a
run 'env-os' grep '^PRETTY_NAME=' /etc/os-release

if [ "$(id -u 2>/dev/null || echo 0)" != "0" ]; then
  note 'запущено не от root: часть секций ниже упрётся в права, а не в отсутствие данных'
  printf '\n'
fi

# --- Где живёт fastpanel ---------------------------------------------------

# Повторяем `get_fastpanel_path` из `fastpanel.rs`: сначала `which fastpanel`,
# затем проверка запасного пути. Оба шага — секции, потому что для документации
# важно не только где бинарь лежит, но и каким из двух способов он нашёлся.
run 'fastpanel-which' which fastpanel
if [ "$LAST_CODE" -eq 0 ]; then
  # Первая строка без обрамляющих пробелов — то же, что делает
  # `get_fastpanel_path` (`out.trim().lines().next()`): `read` с обычным IFS
  # берёт ровно её и сам снимает пробелы по краям.
  read -r FP_BIN <<<"$LAST_OUT" || FP_BIN=''
fi

run 'fastpanel-fallback' test -x "$FASTPANEL_FALLBACK_PATH"
if [ -z "$FP_BIN" ] && [ "$LAST_CODE" -eq 0 ]; then
  FP_BIN="$FASTPANEL_FALLBACK_PATH"
fi

section 'fastpanel-path'
if [ -n "$FP_BIN" ]; then
  note "бинарь fastpanel: $FP_BIN"
else
  note 'бинарь fastpanel не найден — все его секции будут пропущены'
fi
printf '\n'

# --- Сам CLI ---------------------------------------------------------------

fp 'fastpanel-help' --help

# --- Сайты -----------------------------------------------------------------

fp 'sites-help' sites --help
fp 'sites-list-json' sites list --json

# Придержим json: из него берётся домен, если оператор его не передал. Проверка
# `FP_BIN` обязательна — без бинаря секция выше пропущена, а `LAST_*` остались от
# предыдущей команды, и без неё мы разбирали бы чужой вывод.
SITES_JSON=''
if [ -n "$FP_BIN" ] && [ "$LAST_CODE" -eq 0 ]; then SITES_JSON="$LAST_OUT"; fi

fp 'sites-list-text' sites list

# --- FTP-аккаунты ----------------------------------------------------------

# `list`, а не `create`: в argv второй стоит пароль, и её вывод панель повторяет
# вместе с argv (`opaque_exit` в `fastpanel.rs`). По опыту продукта `list` отдаёт
# одни логины — но ровно это мы и проверяем, поэтому оператор обязан просмотреть
# вывод перед отправкой, а не поверить комментарию.
fp 'ftp-help' ftp_account --help
fp 'ftp-list-json' ftp_account list --json
fp 'ftp-list-text' ftp_account list

# --- Базы данных -----------------------------------------------------------

fp 'database-help' database --help
fp 'database-list-json' database list --json
fp 'database-list-text' database list

# --- Сертификаты -----------------------------------------------------------

fp 'certificates-help' certificates --help

# --- PHP -------------------------------------------------------------------

# «Если есть»: команды `php` у панели может не оказаться вовсе, и код возврата
# скажет об этом яснее, чем предварительная проверка.
fp 'php-help' php --help

# --- Какой домен смотрим ---------------------------------------------------

# Первый домен из json произвольной формы. Формы мы как раз и не знаем — отсюда
# обход по всему дереву и набор ключей-кандидатов, а не путь к полю. Тем же
# приёмом (`json_slice` в `fastpanel.rs`) отрезается мусор перед json: локальный
# warning панели ломает разбор целиком.
first_domain_from_json() {
  command -v python3 >/dev/null 2>&1 || return 1
  SDMP_SITES_JSON="$1" python3 -c '
import json, os, sys

raw = os.environ.get("SDMP_SITES_JSON", "")
starts = [p for p in (raw.find("["), raw.find("{")) if p >= 0]
if not starts:
    sys.exit(1)
try:
    data, _ = json.JSONDecoder().raw_decode(raw[min(starts):])
except Exception:
    sys.exit(1)

KEYS = ("server_name", "domain", "domain_name", "name", "site")

def walk(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in KEYS and isinstance(value, str) and "." in value:
                yield value
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)

for found in walk(data):
    print(found)
    sys.exit(0)
sys.exit(1)
' 2>/dev/null
}

section 'domain'
if [ -n "$DOMAIN_ARG" ]; then
  DOMAIN="$DOMAIN_ARG"
  DOMAIN_SOURCE='аргумент командной строки'
elif [ -n "$SITES_JSON" ]; then
  candidate="$(first_domain_from_json "$SITES_JSON" | head -n 1)"
  if [ -n "$candidate" ]; then
    DOMAIN="$candidate"
    DOMAIN_SOURCE='первый сайт из sites list --json'
  fi
fi

# Запасной путь — та же раскладка каталогов, на которую опирается `list_sites` в
# `fastpanel.rs` (`site_path_re`). Нужен, когда панели нет, json не разобрался
# или на машине нет python3.
if [ -z "$DOMAIN" ]; then
  for candidate_path in "$WWW_ROOT"/*/data/www/*; do
    [ -d "$candidate_path" ] || continue
    DOMAIN="${candidate_path##*/}"
    DOMAIN_SOURCE="первый каталог $WWW_ROOT/*/data/www/*"
    break
  done
fi

# Домен, приехавший с сервера, проходит ту же проверку формы, что и аргумент: в
# пути и в `find` он попадает одинаково.
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  note "домен «$DOMAIN» отброшен: не похож на домен"
  DOMAIN=''
fi

if [ -n "$DOMAIN" ]; then
  note "домен: $DOMAIN (источник: $DOMAIN_SOURCE)"
else
  note 'домен не определён — доменные секции будут пропущены'
fi

# Владелец и путь сайта: из них строятся пути логов, и заодно это проверка того,
# что раскладка /var/www/<user>/data/www/<domain> на этой машине именно такая.
if [ -n "$DOMAIN" ]; then
  for candidate_path in "$WWW_ROOT"/*/data/www/"$DOMAIN"; do
    [ -d "$candidate_path" ] || continue
    SITE_PATH="$candidate_path"
    SITE_USER="${candidate_path#"$WWW_ROOT"/}"
    SITE_USER="${SITE_USER%%/*}"
    break
  done
  if [ -n "$SITE_USER" ]; then
    note "владелец сайта: $SITE_USER, путь: $SITE_PATH"
  else
    note "каталог $WWW_ROOT/*/data/www/$DOMAIN не найден"
  fi
fi
printf '\n'

if [ -n "$SITE_PATH" ]; then
  run 'site-dir' ls -ld "$SITE_PATH"
else
  skip_section 'site-dir' 'путь сайта не определён'
fi

# --- Конфиги сайта ---------------------------------------------------------

# Собрать конфиги одного веб-сервера: сначала раскладка каталога (как панель
# вообще раскладывает конфиги), потом файлы этого домена.
#
# Читаем только конфиги веб-сервера. Файлы приложения и пулы php-fpm не трогаем
# намеренно: в первых лежат пароли БД, во вторых — переменные окружения с ними же.
collect_site_configs() {
  local prefix="$1" root="$2"

  # Пропускаем все три секции, а не молчим о них: набор секций в выводе должен
  # быть одинаковым на любой машине, иначе разрез вывода зависит от того, что
  # на сервере установлено.
  if [ ! -d "$root" ]; then
    skip_section "$prefix-dir" "каталога $root нет"
    skip_section "$prefix-tree" "каталога $root нет"
    skip_section "$prefix-conf" "каталога $root нет"
    return 0
  fi

  run_sh "$prefix-dir" "ls -la $root | head -n $MAX_LIST_LINES"
  run_sh "$prefix-tree" \
    "find $root -maxdepth 3 -type f -name '*.conf' | head -n $MAX_LIST_LINES"

  if [ -z "$DOMAIN" ]; then
    skip_section "$prefix-conf" 'домен не определён'
    return 0
  fi

  # Ищем по префиксу имени, а не по точному `<домен>.conf`: как именно панель
  # называет файл, мы как раз и выясняем.
  local found
  found="$(find "$root" -maxdepth 3 -type f -name "${DOMAIN}*" 2>/dev/null | head -n "$MAX_SITE_CONFIGS")"
  if [ -z "$found" ]; then
    skip_section "$prefix-conf" "файлов ${DOMAIN}* в $root нет"
    return 0
  fi

  local file
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    CONF_FILES+=("$file")
    run "$prefix-conf" cat "$file"
  done <<<"$found"
}

collect_site_configs 'nginx' "$NGINX_SITES_DIR"
collect_site_configs 'apache' "$APACHE_SITES_DIR"

# --- Раскладка логов -------------------------------------------------------

# Два источника, и они дополняют друг друга: каталог показывает, что реально
# лежит на диске (имена и размеры), а директивы конфига — куда веб-сервер пишет
# на самом деле. Совпадать они не обязаны.
if [ -n "$SITE_USER" ]; then
  # `printf %q`, потому что имя владельца приехало с чужой машины (это имя
  # каталога в /var/www), а здесь оно впервые попадает в строку для шелла.
  logs_dir_quoted="$(printf '%q' "$WWW_ROOT/$SITE_USER/data/logs")"
  run_sh 'site-logs' "ls -la $logs_dir_quoted | head -n $MAX_LIST_LINES"
else
  skip_section 'site-logs' 'владелец сайта не определён'
fi

if [ "${#CONF_FILES[@]}" -gt 0 ]; then
  run 'log-directives' grep -nE 'access_log|error_log|CustomLog|ErrorLog|TransferLog' "${CONF_FILES[@]}"
else
  skip_section 'log-directives' 'конфиги сайта не найдены'
fi

# Подпись «вывод доехал целиком» — та же роль, что у `#sdmp:end` в
# `COLLECT_METRICS_COMMAND`: без неё непонятно, кончился прогон или оборвался.
printf '%send\n' "$MARK"
