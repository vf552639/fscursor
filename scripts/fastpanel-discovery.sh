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
# Секции с префиксом `backup-*` добавлены позже и отвечают на другой вопрос: где
# панель держит бэкапы, чем и по какому расписанию их делает, есть ли на сервере
# `tar`/`mysqldump` и отвечает ли `mysql` под root через сокет (фаза 0 плана
# `plans/2026-08-19-bekapy-domena.md`).
#
# ТОЛЬКО ЧТЕНИЕ. Ни одна команда здесь ничего не создаёт, не меняет и не удаляет:
# `--help`, `--version`, `list`, `test`, `ls`, `find`, `cat`, `grep`, `command -v`,
# `df`, `systemctl list-timers`, а из `mysql` — только `SHOW`, `DESCRIBE` и
# `SELECT COUNT(*)`. Скрипт идёт на живой продакшн, и это требование жёстче любого
# удобства — новую команду сюда можно добавлять только убедившись, что она читающая.
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
# Секции чтения конфигов нумерованы: `nginx-conf-1`, `nginx-conf-2`, … по одному
# файлу на секцию (и так же для `apache-conf-N`). Номер держит имя уникальным,
# сколько бы конфигов у домена ни нашлось; `*-conf-0` — «читать было нечего»
# (каталога, домена или файлов нет).
#
# Всё до первого маркера — предупреждение оператору и SSH-баннер, не данные.
#
# Использование:
#   bash scripts/fastpanel-discovery.sh [домен] > discovery.txt
#
# Без `2>&1` намеренно: stderr самих команд перехватывается внутри `run`/`run_sh`
# и уходит в файл через stdout, а на канале stderr остаётся только копия
# предупреждения — при `> discovery.txt` она и покажется оператору на экране.
# Дописать `2>&1` значило бы спрятать предупреждение обратно в файл.
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

# Сколько таблиц с `backup` в имени разбираем во внутренней БД панели. Их там в
# норме одна-две; больше — это уже совпадение по подстроке, и `DESCRIBE` на каждую
# только раздувает вывод.
readonly MAX_BACKUP_TABLES=5

# Куда FastPanel может складывать архивы. Каждое место — своя пара секций: «каталога
# нет» и «каталог есть, но пуст» — разные факты, и различить их можно только так.
readonly BACKUP_PLACES_VAR_BACKUPS='/var/backups'
readonly BACKUP_PLACES_FASTPANEL='/var/lib/fastpanel2'
readonly BACKUP_PLACES_MNT='/mnt'
readonly BACKUP_PLACES_BACKUP='/backup'

# Глубина обхода и фильтр имён для поиска архивов.
#
# Фильтр по имени обязателен, а не удобен: каталог `/var/www/<owner>/data` содержит
# сам сайт, и `find` без фильтра выдал бы сотню файлов приложения вместо архивов —
# `head -n MAX_LIST_LINES` обрезал бы вывод раньше, чем дошёл до бэкапов. Пустой
# вывод такой секции читается как «файлов с этими именами нет», а не «каталог пуст»:
# на «пусто» отвечает соседняя секция `-dir`.
readonly BACKUP_FIND_DEPTH=4
readonly BACKUP_NAME_FILTER="-name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' -o -name '*.tar.bz2' -o -name '*.zip' -o -name '*.sql' -o -name '*.sql.gz' -o -name '*.bak' -o -name '*backup*'"

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
#
# `set -o pipefail` внутри подоболочки: все конвейеры здесь — `find|head` и
# `ls|head`, и без него `#sdmp:exit` отражал бы код `head`, а не исследуемой
# команды, хотя в шапке заявлено обратное. Побочный эффект приемлем и
# информативен: когда `head` обрывает длинный вывод, отправитель ловит SIGPIPE и
# код секции становится 141 — это видно в выводе и означает «данных было больше
# лимита», а не отказ. Скрипт при этом не падает: `set -e` тут нет, а pipefail
# заперт в подоболочке `$(...)` и на остальные секции не распространяется.
run_sh() {
  local name="$1" cmd="$2"
  section "$name"
  printf '%scmd %s\n' "$MARK" "$cmd"
  if [ -n "$TIMEOUT_BIN" ]; then
    LAST_OUT="$("$TIMEOUT_BIN" "$CMD_TIMEOUT" bash -c "set -o pipefail; $cmd" </dev/null 2>&1)"
  else
    LAST_OUT="$(bash -c "set -o pipefail; $cmd" </dev/null 2>&1)"
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
Использование: bash scripts/fastpanel-discovery.sh [домен] > discovery.txt

  домен   для секций с конфигами nginx/apache и раскладкой логов.
          Не передан — берётся первый сайт с сервера.

Без 2>&1: так предупреждение о логинах и путях останется на экране.
Скрипт только читает: --help, --version (tar), list, test, ls, find, cat, grep,
command -v, df, systemctl list-timers и mysql SHOW/DESCRIBE/SELECT COUNT(*).
Запускать от root.
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
 имена баз, пути к файлам и конфиги nginx/apache, а также имена файлов бэкапов,
 список системных таймеров и имена таблиц во внутренней БД панели.
 Паролей мы не собираем: команды с паролем в argv не запускаются, файлы
 приложений (wp-config.php и подобные) и пулы php-fpm не читаются вовсе,
 `crontab -l` не зовётся (в строке cron может стоять mysqldump с паролем),
 а из таблиц бэкапов берутся только структура и число строк, но не сами строки.

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

# --- Бэкапы: команды панели -------------------------------------------------

# `backup:plan` — единственная известная нам команда про бэкапы: она есть даже у
# непривилегированного пользователя панели (`docs/FASTPANEL_CLI.md` §0), но её ни
# разу не звали, и форма вывода неизвестна. `--help` и `list` читающие; ничего вроде
# `backup:plan create` здесь быть не может — скрипт ходит на живой продакшн.
fp 'backup-plan-help' backup:plan --help
fp 'backup-plan-list-json' backup:plan list --json
fp 'backup-plan-list-text' backup:plan list

# Две лишние строки против одного повторного захода на продакшн: `database` против
# `databases` (`docs/FASTPANEL_CLI.md` §3.1) уже стоил бага в провижининге — там
# команда называлась во множественном числе, а слали единственное, и разведка этого
# не проверила. Здесь спрашиваем оба написания сразу, чтобы имя группы было снято
# фактом, а не догадкой по аналогии с `backup:plan`.
#
# Честно о рисках этих двух строк: имён `backup` и `backups` мы не видели ни в
# `--help` панели, ни в коде, поэтому УБЕДИТЬСЯ в их читающести, как требует шапка,
# было негде. Ставка в том, что `--help` в CLI-фреймворках разбирается до
# выполнения: неизвестное имя даст `expected command but got "backup"` (так ответил
# `database`), известное — usage. Ставка осознанная, и если следующий разведчик
# решит, что проверка была, — не было.
fp 'backup-help' backup --help
fp 'backups-help' backups --help

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
  note "домен «${DOMAIN}» отброшен: не похож на домен"
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
  # Конфигов у домена бывает несколько (nginx + apache, а то и по паре на
  # вариант), поэтому секция чтения нумерованная: `<prefix>-conf-1`,
  # `<prefix>-conf-2`, … Одно и то же имя, повторённое переменное число раз,
  # ломало бы адресацию по имени у парсера; суффикс-номер делает каждую секцию
  # уникальной. Случай «файлов нет» — это `<prefix>-conf-0`: набор имён секций
  # тогда одинаков на любой машине, а по номеру 0 видно, что читать было нечего.
  if [ ! -d "$root" ]; then
    skip_section "$prefix-dir" "каталога $root нет"
    skip_section "$prefix-tree" "каталога $root нет"
    skip_section "$prefix-conf-0" "каталога $root нет"
    return 0
  fi

  run_sh "$prefix-dir" "ls -la $root | head -n $MAX_LIST_LINES"
  run_sh "$prefix-tree" \
    "find $root -maxdepth 3 -type f -name '*.conf' | head -n $MAX_LIST_LINES"

  if [ -z "$DOMAIN" ]; then
    skip_section "$prefix-conf-0" 'домен не определён'
    return 0
  fi

  # Ищем по префиксу имени, а не по точному `<домен>.conf`: как именно панель
  # называет файл, мы как раз и выясняем.
  local found
  found="$(find "$root" -maxdepth 3 -type f -name "${DOMAIN}*" 2>/dev/null | head -n "$MAX_SITE_CONFIGS")"
  if [ -z "$found" ]; then
    skip_section "$prefix-conf-0" "файлов ${DOMAIN}* в $root нет"
    return 0
  fi

  local file n=0
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    n=$((n + 1))
    CONF_FILES+=("$file")
    run "$prefix-conf-$n" cat "$file"
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

# --- Бэкапы: раскладка на диске --------------------------------------------

# Одно место, где могут лежать архивы, — две секции, как у конфигов сайта:
# `<prefix>-dir` показывает сам каталог, `<prefix>-files` — файлы в нём. Разделение
# не косметическое, оно и даёт три различимых ответа. Как их читать:
#
#   каталога нет          `-dir` и `-files` помечены `#sdmp:skip`
#   каталог есть и пуст   `-dir` = `total 0` плюс строки `.` и `..` и больше ничего
#                         (пустого вывода тут не бывает: `ls -la` всегда печатает
#                         сами каталоги — не ищи признак, которого нет), `-files` пуст
#   архивов нет           `-dir` со списком записей, `-files` пуст
#
# Одна секция на место эти три случая слепила бы в один.
#
# Время и размер снимаем через `find -printf`, а не `ls -l`: формат `ls` зависит от
# локали сервера (месяц словом, разделитель дробной части), и парсер на Rust ловил
# бы чужой язык. `-printf` даёт ISO-дату и байты при любой локали.
collect_backup_place() {
  local prefix="$1" root="$2"

  if [ ! -d "$root" ]; then
    skip_section "$prefix-dir" "каталога $root нет"
    skip_section "$prefix-files" "каталога $root нет"
    return 0
  fi

  # `printf %q`: часть путей собрана из имени владельца сайта, приехавшего с чужой
  # машины, и здесь оно впервые попадает в строку для шелла.
  local root_q
  root_q="$(printf '%q' "$root")"

  run_sh "$prefix-dir" "ls -la $root_q | head -n $MAX_LIST_LINES"
  run_sh "$prefix-files" \
    "find $root_q -maxdepth $BACKUP_FIND_DEPTH -type f \\( $BACKUP_NAME_FILTER \\) -printf '%p\\t%s\\t%TY-%Tm-%Td %TH:%TM\\n' | head -n $MAX_LIST_LINES"
}

# Каталог владельца сайта — первое место, куда панель могла бы класть копии домена;
# он единственный из пяти зависит от разбора домена выше.
if [ -n "$SITE_USER" ]; then
  collect_backup_place 'backup-fs-www' "$WWW_ROOT/$SITE_USER/data"
else
  skip_section 'backup-fs-www-dir' 'владелец сайта не определён'
  skip_section 'backup-fs-www-files' 'владелец сайта не определён'
fi

collect_backup_place 'backup-fs-var-backups' "$BACKUP_PLACES_VAR_BACKUPS"
collect_backup_place 'backup-fs-fastpanel2' "$BACKUP_PLACES_FASTPANEL"
collect_backup_place 'backup-fs-mnt' "$BACKUP_PLACES_MNT"
collect_backup_place 'backup-fs-backup' "$BACKUP_PLACES_BACKUP"

# --- Бэкапы: расписание ----------------------------------------------------

# `crontab -l` НЕ зовём и звать нельзя. В cron-строке панели может стоять
# `mysqldump -p<пароль>`, а шапка скрипта обещает оператору, что паролей мы не
# собираем — одно такое обещание дороже, чем удобство разведки. По той же причине
# каталог `/etc/cron.d` только перечисляется (`ls`), но файлы из него не читаются.
# Расписание нам нужно как факт «панель что-то делает по таймеру», а не построчно.
run_sh 'backup-timers' "systemctl list-timers --all --no-pager | head -n $MAX_LIST_LINES"

if [ -d /etc/cron.d ]; then
  run_sh 'backup-cron-d' "ls -la /etc/cron.d | head -n $MAX_LIST_LINES"
else
  skip_section 'backup-cron-d' 'каталога /etc/cron.d нет'
fi

# --- Бэкапы: внутренняя БД панели ------------------------------------------

# Секция важна не столько своим выводом, сколько побочным фактом: отвечает ли
# `mysql` под root БЕЗ пароля через unix-сокет. На этом стоит вся схема `mysqldump`
# в фазе 2 плана — если сокет-авторизации нет, дампить БД домена нечем, и это надо
# знать до того, как код написан, а не после.
#
# ⚠️ `SELECT *` по таблицам бэкапов ЗАПРЕЩЁН: в их строках лежат учётки внешних
# хранилищ (S3/FTP), а вывод разведки уезжает с сервера. Отсюда только `SHOW
# TABLES`, `DESCRIBE` и `SELECT COUNT(*)` — форма и объём без содержимого.
run 'backup-mysql-databases' mysql -N -B -e "SHOW DATABASES LIKE '%fastpanel%'"
MYSQL_DB_CODE="$LAST_CODE"

# Первая ПОДХОДЯЩАЯ строка, а не просто первая. `run` сливает stderr в тот же
# буфер, а mysql охотно ворчит туда перед данными («[Warning] World readable config
# file …», «[Warning] Using a password …»). Слепой `head -1` взял бы это ворчание,
# оно не прошло бы проверку формы — и самая важная группа секций молча ушла бы в
# skip при найденной базе. Поэтому строки, не похожие на имя базы, здесь шум и
# пропускаются; упрощать разбор обратно до первой строки нельзя.
FP_DB=''
if [ "$MYSQL_DB_CODE" -eq 0 ]; then
  while IFS= read -r mysql_line; do
    [[ "$mysql_line" =~ ^[A-Za-z0-9_]+$ ]] || continue
    FP_DB="$mysql_line"
    break
  done <<<"$LAST_OUT"
  # Ответ был, а имени в нём не нашлось — это отдельный факт, и он должен быть
  # назван: иначе «панель ответила непонятным» неотличимо от «mysql не ответил».
  if [ -z "$FP_DB" ] && [ -n "$LAST_OUT" ]; then
    note 'в ответе mysql не нашлось строки, похожей на имя базы — см. секцию выше'
    printf '\n'
  fi
fi

# «Базы не нашлось» и «mysql не пустил» ведут к противоположным решениям в фазе 2:
# в первом случае сокет-авторизация работает и `mysqldump` возможен, во втором мы не
# знаем даже этого. Ради этого различия секция и заведена, поэтому причина пропуска
# ниже смотрит на код возврата, а не только на пустоту имени.
FP_DB_MISS='внутренняя БД панели не найдена'
if [ "$MYSQL_DB_CODE" -ne 0 ]; then
  FP_DB_MISS="секция backup-mysql-databases отказала (код $MYSQL_DB_CODE) — есть ли внутренняя БД панели, неизвестно"
fi

BACKUP_TABLES=''
BACKUP_TABLES_CODE=0
if [ -n "$FP_DB" ]; then
  # `|| true` на `grep` — не глушение ошибки, а единственный способ сделать код
  # секции осмысленным. `pipefail` возвращает ПРАВЫЙ ненулевой код, а `grep` без
  # совпадений отдаёт 1 — ровно то же самое, что приезжает, когда mysql отказал и
  # фильтровать было нечего. Два противоположных факта («таблиц с backup нет» и
  # «mysql не пустил») приходили бы под одним кодом, и секция ниже вынуждена была бы
  # гадать. С нейтрализованным `grep` код секции значит одно: сломался ли конвейер.
  # «Совпадений нет» читается после этого по числу разобранных имён, а не по коду:
  # пустым вывод секции всё равно не бывает, пока mysql ворчит в stderr.
  run_sh 'backup-mysql-tables' \
    "mysql $(printf '%q' "$FP_DB") -N -B -e 'SHOW TABLES' | { grep -i backup || true; } | head -n $MAX_LIST_LINES"
  BACKUP_TABLES_CODE="$LAST_CODE"
  # Разбираем вывод при ЛЮБОМ коде, а не только при нуле. Иначе обрыв по `head`
  # (код 141 — сам скрипт объявил его ожидаемым, а не аварией) выбрасывал бы
  # напечатанные тут же двести имён и заставлял бы секцию ниже говорить «таблиц
  # нет» через десять строк после их списка. Мусор отсеет проверка формы в цикле.
  BACKUP_TABLES="$LAST_OUT"
  # Обрыв по `head` ловим двумя независимыми признаками, и это не перестраховка.
  # Код 141 приезжает, только если по SIGPIPE умер тот, чей код доживёт до
  # `pipefail`, — а `grep` мы выше специально обезвредили, и умереть может уже он.
  # Число строк вровень с потолком не зависит от того, кто именно умер.
  backup_tables_lines=0
  if [ -n "$BACKUP_TABLES" ]; then
    backup_tables_lines="$(printf '%s\n' "$BACKUP_TABLES" | wc -l | tr -d ' ')"
  fi
  if [ "$BACKUP_TABLES_CODE" -eq 141 ] || [ "$backup_tables_lines" -ge "$MAX_LIST_LINES" ]; then
    note "строк в ответе $backup_tables_lines при потолке $MAX_LIST_LINES (код $BACKUP_TABLES_CODE) — список мог быть обрезан, имён могло быть больше"
    printf '\n'
  fi
else
  skip_section 'backup-mysql-tables' "$FP_DB_MISS"
fi

# Нумерованные секции по образцу `*-conf-N`: таблиц может не быть ни одной, а может
# быть несколько, и `backup-mysql-table-0` — это «разбирать было нечего».
backup_table_n=0
backup_table_rejected=0
backup_table_over=0
if [ -n "$BACKUP_TABLES" ]; then
  while IFS= read -r backup_table; do
    # Имя уходит в argv `mysql`, поэтому форму проверяем. Разбор так же устойчив к
    # шуму, как и разбор имени базы выше, и по той же причине: `run_sh` сливает в
    # буфер stderr всей подоболочки, а он идёт мимо `grep` — предупреждение mysql
    # попадает сюда, ни разу не побывав в конвейере. Пропущенную строку называем
    # вслух: молчаливый пропуск выглядел бы как «такой строки и не было».
    if ! [[ "$backup_table" =~ ^[A-Za-z0-9_]+$ ]]; then
      note "строка «${backup_table}» пропущена: не похожа на имя таблицы"
      printf '\n'
      backup_table_rejected=$((backup_table_rejected + 1))
      continue
    fi
    backup_table_n=$((backup_table_n + 1))
    # `continue`, а не `break`: остаток списка дочитывается ради счётчика. Молчаливая
    # обрезка — то же незнание, нарисованное отсутствием, что и «таблиц нет»: по
    # выводу было бы не отличить «таблиц ровно пять» от «пять из семнадцати».
    if [ "$backup_table_n" -gt "$MAX_BACKUP_TABLES" ]; then
      backup_table_over=$((backup_table_over + 1))
      continue
    fi
    run "backup-mysql-table-$backup_table_n" mysql "$FP_DB" \
      -e "DESCRIBE $backup_table; SELECT COUNT(*) FROM $backup_table"
  done <<<"$BACKUP_TABLES"
fi
if [ "$backup_table_over" -gt 0 ]; then
  note "разобраны первые $MAX_BACKUP_TABLES таблиц из $backup_table_n: ещё $backup_table_over пропущено потолком MAX_BACKUP_TABLES"
  printf '\n'
fi
# «Нечего разбирать» бывает по четырём разным причинам, и одной формулировкой на все
# четыре мы утверждали бы больше, чем знаем. Порядок веток — от «мы вообще не
# спрашивали» к «спросили и получили ответ»:
#
#   имени базы нет      причина взята из FP_DB_MISS: не найдена ≠ mysql отказал
#   код ненулевой       конвейер сломался — «таблиц нет» тут было бы выдумкой
#   код 0, есть отказы  таблиц нет, но в ответе были строки не той формы: говорим оба
#                       факта, а не выбираем удобный
#   код 0, чисто        таблиц с backup в имени действительно нет
#
# Сказать «таблиц нет» позволено только при коде 0: он и означает, что mysql ответил.
if [ "$backup_table_n" -eq 0 ]; then
  if [ -z "$FP_DB" ]; then
    skip_section 'backup-mysql-table-0' "$FP_DB_MISS"
  elif [ "$BACKUP_TABLES_CODE" -ne 0 ]; then
    skip_section 'backup-mysql-table-0' \
      "секция backup-mysql-tables закончилась кодом $BACKUP_TABLES_CODE — есть ли таблицы в $FP_DB, неизвестно"
  elif [ "$backup_table_rejected" -gt 0 ]; then
    skip_section 'backup-mysql-table-0' \
      "подходящих таблиц с backup в имени в $FP_DB нет; строк не той формы: $backup_table_rejected — они названы выше"
  else
    skip_section 'backup-mysql-table-0' "подходящих таблиц с backup в имени в $FP_DB нет"
  fi
fi

# --- Бэкапы: инструменты ---------------------------------------------------

# Цикл, а не `command -v` одним списком: со списком bash печатает пути только
# найденных и отдаёт код последнего имени — отсутствующий `ionice` в такой секции
# выглядит как отсутствие строки, которую ещё надо заметить. Строка `MISSING` против
# каждого имени отвечает на вопрос прямо, а не вычитанием одного списка из другого.
run_sh 'backup-tools' \
  "for t in tar gzip mysqldump sha256sum du df nice ionice install; do printf '%s\\t%s\\n' \"\$t\" \"\$(command -v \"\$t\" || echo MISSING)\"; done"

# GNU tar и busybox tar расходятся кодами возврата: у GNU 1 — «файлы менялись при
# чтении» (для живого сайта норма и не повод считать архив битым), 2 — настоящий
# сбой; busybox такой градации не даёт вовсе. Схема обработки кодов в фазе 2 зависит
# от того, какой именно tar стоит на сервере, — отсюда отдельная секция.
run 'backup-tar-version' tar --version

# `-Pk`: POSIX-формат и килобайты — иначе размер приезжает в «человеческих» единицах
# с суффиксом, зависящим от локали, а его надо сравнивать с оценкой размера архива.
run 'backup-df-var-tmp' df -Pk /var/tmp

# Подпись «вывод доехал целиком» — та же роль, что у `#sdmp:end` в
# `COLLECT_METRICS_COMMAND`: без неё непонятно, кончился прогон или оборвался.
printf '%send\n' "$MARK"
