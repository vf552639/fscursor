#!/usr/bin/env bash
#
# Собирает .dmg десктоп-приложения SDMP одной командой: проверяет тулчейн,
# ставит npm-зависимости (desktop/ и frontend/), гонит `tauri build` только
# для macOS-таргета и печатает пути к артефактам. С флагом --run ещё и
# открывает собранный .app.
#
# ПОЧЕМУ ТОЛЬКО --bundles app,dmg. В tauri.conf.json bundle.targets содержит
# ["dmg", "nsis", "appimage"] — Windows и Linux пока не наша задача (Stage 5,
# отложено намеренно). Без явного --bundles `tauri build` попробует собрать
# все три и упадёт на отсутствующих Windows/Linux-тулчейнах. А `app` в списке
# нужен не «за компанию»: с одним лишь `dmg` tauri после упаковки образа
# вычищает bundle/macos/, и SDMP.app не остаётся — открывать по --run нечего.
#
# ПОЧЕМУ ТОЛЬКО host-арка. Universal-бинарь (aarch64+x86_64) — отдельная
# задача Stage 5; собирать его сейчас — YAGNI. Какая именно арка host —
# скрипт узнаёт у `rustc -vV`, а не хардкодит: на Intel-маке это x86_64, на
# Apple Silicon — aarch64, и preflight должен спрашивать/советовать ставить
# ровно тот таргет, что нужен здесь и сейчас.
#
# ПОЧЕМУ СБОРКА ПО УМОЛЧАНИЮ НИЧЕГО НЕ ОТКРЫВАЕТ. Скрипт должен годиться и
# для «просто собери артефакт» (повторный прогон, будущий CI) — неожиданно
# открывающееся окно там сюрприз, а не польза. Открытие — только по --run.
#
# Использование:
#   ./build-dmg.sh            # собрать .dmg и .app, пути напечатать
#   ./build-dmg.sh --run      # собрать и сразу открыть получившийся .app
#   ./build-dmg.sh --check    # только preflight-проверки, без сборки
#   ./build-dmg.sh --help     # эта справка

set -euo pipefail

die()  { echo "❌ $*" >&2; exit 1; }
step() { echo "→ $*"; }
ok()   { echo "✅ $*"; }
# Предупреждения — тоже в stderr, а не в stdout: это не часть «полезного
# вывода» команды (путей к артефактам), и вызывающая сторона (CI, `npm run
# dmg`), которая парсит только stdout, не должна принять warning за путь.
warn() { echo "⚠️  $*" >&2; }

# Пути считаем от расположения скрипта, а не от cwd: скрипт должен работать
# при запуске из любой директории (например `cd /tmp && /path/to/build-dmg.sh`).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$(cd "$DESKTOP_DIR/../frontend" 2>/dev/null && pwd)" \
  || die "Не нашёл frontend/ рядом с desktop/ (ожидал $DESKTOP_DIR/../frontend)"
SRC_TAURI_DIR="$DESKTOP_DIR/src-tauri"
TAURI_CONF="$SRC_TAURI_DIR/tauri.conf.json"

RUN_APP=0
CHECK_ONLY=0

usage() {
  cat <<EOF
Использование: $0 [--run] [--check] [-h|--help]

  (без флагов)  собрать .dmg и .app, пути напечатать, ничего не открывать
  --run         после сборки открыть получившийся .app (backend должен уже
                слушать на http://localhost:8100 — приложение стучится туда)
  --check       выполнить только preflight-проверки тулчейна и зависимостей,
                без сборки (--run вместе с ним игнорируется)
  -h, --help    показать эту справку
EOF
}

for arg in "$@"; do
  case "$arg" in
    --run) RUN_APP=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Неизвестный аргумент: $arg (см. --help)" ;;
  esac
done

if [ "$CHECK_ONLY" -eq 1 ] && [ "$RUN_APP" -eq 1 ]; then
  warn "--check и --run вместе: --check главнее — ни сборки, ни открытия не будет."
fi

# ── Preflight ────────────────────────────────────────────────────────────
# Проверяем тулчейн заранее и печатаем понятную причину с командой-фиксом,
# а не даём `tauri build` упасть посреди сборки с невнятной ошибкой линковщика
# через десять минут ожидания.
preflight() {
  step "Preflight: проверяю тулчейн…"

  command -v cargo >/dev/null 2>&1 \
    || die "cargo не найден. Поставь Rust: https://rustup.rs"
  command -v rustc >/dev/null 2>&1 \
    || die "rustc не найден. Поставь Rust: https://rustup.rs"
  command -v node >/dev/null 2>&1 \
    || die "node не найден. Поставь Node.js (например через nvm)."
  command -v npm >/dev/null 2>&1 \
    || die "npm не найден. Поставь Node.js (например через nvm)."

  # Триплет хоста узнаём у самого rustc, а не хардкодим: на Intel-маке это
  # x86_64-apple-darwin, на Apple Silicon — aarch64-apple-darwin. `awk` тут
  # читает весь вывод `rustc -vV` до конца сам — в отличие от `grep -q` в
  # пайпе (см. разбор SIGPIPE-капкана в dev-signing.sh:113-117), обрывать
  # верхнюю команду раньше времени некому.
  # `|| die` висит прямо на присваивании, не на следующей строке: под
  # pipefail статус пайпа — это статус ПОСЛЕДНЕЙ команды, упавшей с ошибкой,
  # а не обязательно последней по порядку. Если rustc упадёт (например,
  # rustup-шим без выставленного default toolchain), а awk на пустом
  # stdin как обычно завершится нулём, pipefail всё равно вернёт код rustc —
  # и простое присваивание уронит весь скрипт через set -e раньше, чем
  # выполнится проверка на следующей строке. Без своего die тут был бы голый
  # exit 1 без единого ❌.
  local host_target
  host_target="$(rustc -vV | awk '/^host:/{print $2}')" \
    || die "rustc есть в PATH, но не отвечает на 'rustc -vV' (см. ошибку выше). Возможно, не задан тулчейн: rustup default stable"
  [ -n "$host_target" ] \
    || die "Не смог определить хост-таргет: 'rustc -vV' не вернул строку host:."

  # Без rustup таргет проверить нечем (тулчейн мог быть поставлен напрямую).
  # В этом случае НЕ рапортуем успех молча — печатаем честное «не проверял»,
  # а не выдаём непроверенный таргет за подтверждённый. Ровно такая немая
  # «мягкая проверка» с mock-хранилищем уже стоила этому репозитория рабочего
  # продукта (коммит 26bf693, см. dev-signing.sh).
  local target_note
  if command -v rustup >/dev/null 2>&1; then
    local targets
    targets="$(rustup target list --installed 2>/dev/null || true)"
    if [[ "$targets" == *"$host_target"* ]]; then
      target_note="таргет $host_target установлен"
    else
      die "Таргет $host_target не установлен. Выполни: rustup target add $host_target"
    fi
  else
    target_note="таргет не проверял (rustup не в PATH)"
  fi

  ok "Тулчейн на месте: cargo, rustc, node, npm; $target_note."

  # Место на диске цель preflight-а сформулирована как «не давать tauri
  # build упасть посреди сборки через десять минут» — а самый банальный
  # способ так упасть здесь и сейчас — нехватка диска: полная release-сборка
  # Rust-бинарника, сборка фронта (vite) и создание временного rw-образа dmg
  # (bundle_dmg.sh, тот же размер, что итоговый .app) в сумме легко уходят
  # за несколько гигабайт. Смотрим том, где растёт target/release и куда
  # пишется dmg — каталог src-tauri, а не корень диска (это может быть
  # другой том). Пороги — не измеренные точно, а взятые с запасом: 10 GiB —
  # комфортный уровень, при котором сборка почти наверняка не упрётся в
  # диск; 2 GiB — уровень, ниже которого начинать бессмысленно (cargo обычно
  # падает на "No space left on device" не сразу, а после долгой линковки).
  # Конкретное число свободного места на этой машине сегодня в код не
  # зашиваем — это факт про машину, не инвариант скрипта.
  local avail_kb
  avail_kb="$(df -k "$SRC_TAURI_DIR" | awk 'NR==2{print $4}')" || true
  if [[ "$avail_kb" =~ ^[0-9]+$ ]]; then
    local avail_gb=$(( avail_kb / 1024 / 1024 ))
    if (( avail_kb < 2 * 1024 * 1024 )); then
      die "Свободно ~${avail_gb} GiB под $SRC_TAURI_DIR — для release-сборки мало. Освободи место, например: cargo clean (в src-tauri/) снимет target/debug."
    elif (( avail_kb < 10 * 1024 * 1024 )); then
      warn "Свободно ~${avail_gb} GiB под $SRC_TAURI_DIR — release-сборка может не влезть. При нехватке освободи target/debug: cargo clean (в src-tauri/)."
    fi
  else
    warn "Не смог определить свободное место на диске (df не отработал как ожидалось) — пропускаю эту проверку."
  fi
}

# ── Зависимости ──────────────────────────────────────────────────────────
# desktop/node_modules нужен ради @tauri-apps/cli (иначе `npm run tauri`
# звать нечем). frontend/node_modules — отдельный кейс: beforeBuildCommand в
# tauri.conf.json дёргает `tsc && vite build`, и без node_modules сборка
# фронта упадёт ПОСЛЕ старта tauri build, с менее понятной ошибкой из недр
# tauri-cli. Решение: ставим оба одинаково — команда должна правда делать
# всё, а не половину, и это ровно тот edge case, что упомянут в плане.
#
# `npm ci`, когда есть package-lock.json (он есть в обоих каталогах): `npm
# install` вправе подправить лок-файл под текущий npm/registry и оставить
# грязное рабочее дерево с версиями, отличными от зафиксированных. `npm ci`
# ставит строго по локу и падает, если он рассинхронизирован с package.json,
# — то есть либо ставит именно то, что закоммичено, либо честно сообщает,
# что не может.
#
# mode="install" — ставит недостающее; mode="report" — только сообщает (для
# --check), сборку не запускает и ничего не меняет на диске.
#
# Проверяем не сам каталог node_modules, а конкретный файл-маркер внутри —
# `-d node_modules` считает готовым и частично распакованный каталог после
# прерванного npm ci/install (правдоподобно при нынешней нехватке места на
# диске): дальше это всплывёт неочевидной ошибкой из недр tauri-cli, а не
# здесь, где причина ясна. Маркер выбран под каждый каталог свой:
#   - desktop: node_modules/@tauri-apps/cli/package.json — это ЕДИНСТВЕННАЯ
#     причина, по которой desktop/node_modules вообще нужен (npm run tauri
#     дёргает именно этот бинарь), так что смысл проверять его напрямую.
#   - frontend: node_modules/.package-lock.json — служебный файл, который
#     сам npm пишет, отражая фактическое состояние установленного дерева;
#     в frontend/ нет одного «того самого» пакета, зато есть этот маркер
#     от самого npm, ближайший доступный аналог «install точно завершился».
handle_node_modules() {
  local dir="$1" label="$2" mode="$3" marker="$4"

  if [ -e "$dir/$marker" ]; then
    ok "$label/node_modules уже на месте."
    return 0
  fi

  if [ "$mode" = "report" ]; then
    warn "$label/node_modules нет или неполный (нет $marker) — при сборке будет (пере)установлен."
    return 0
  fi

  if [ -f "$dir/package-lock.json" ]; then
    step "$label/node_modules нет или неполный — ставлю по package-lock.json (npm ci)…"
    ( cd "$dir" && npm ci )
  else
    step "$label/node_modules нет, лок-файла тоже нет — ставлю (npm install)…"
    ( cd "$dir" && npm install )
  fi
  [ -e "$dir/$marker" ] \
    || die "npm install/ci в $label/ отработал без ошибки, но $marker всё равно не появился — что-то не так с установкой."
  ok "$label/node_modules установлен."
}

install_deps() {
  handle_node_modules "$DESKTOP_DIR" "desktop" "install" "node_modules/@tauri-apps/cli/package.json"
  handle_node_modules "$FRONTEND_DIR" "frontend" "install" "node_modules/.package-lock.json"
}

report_deps() {
  handle_node_modules "$DESKTOP_DIR" "desktop" "report" "node_modules/@tauri-apps/cli/package.json"
  handle_node_modules "$FRONTEND_DIR" "frontend" "report" "node_modules/.package-lock.json"
}

# Версию приложения (а не версию npm-пакета оболочки из desktop/package.json)
# Tauri берёт из tauri.conf.json — оттуда же читаем и мы, только чтобы
# провалидировать конфиг заранее и не тратить десять минут сборки на ошибку,
# которая была видна с самого начала. Сам путь к .dmg версией больше не
# зашиваем (см. run_build) — имя ищем глобом.
read_version() {
  [ -f "$TAURI_CONF" ] || die "Не найден $TAURI_CONF"

  local version
  version="$(node -e 'console.log(require(process.argv[1]).version)' "$TAURI_CONF" 2>/dev/null)" \
    || die "Не смог прочитать version из $TAURI_CONF — похоже, битый JSON."
  [[ "$version" =~ ^[0-9]+\.[0-9]+ ]] \
    || die "В $TAURI_CONF нет валидного поля version (получил «${version}»)."

  echo "$version"
}

# Временный RW-образ (bundle_dmg.sh: DMG_TEMP_NAME="$DMG_DIR/rw.$$.${DMG_NAME}")
# при успехе убирается сам, а после падения остаётся навсегда — и весит столько
# же, сколько .app (десятки мегабайт). Имя каждый раз новое (в нём pid), так что
# мусор копится молча. Чистим строго по шаблону rw.*.dmg и строго в bundle/macos/.
clean_stale_rw_images() {
  local dir="$SRC_TAURI_DIR/target/release/bundle/macos" f
  [ -d "$dir" ] || return 0
  for f in "$dir"/rw.*.dmg; do
    # Без nullglob неразвёрнутый шаблон приходит сюда как есть — отсеиваем.
    [ -f "$f" ] || continue
    warn "Убираю недоделанный образ от прерванной сборки: $f"
    rm -f "$f"
  done
}

# Вывод сборки нужен сразу в двух видах: на экране (пользователь ждёт и хочет
# видеть прогресс) и в файле (чтобы разобрать причину падения). Отсюда tee, а
# код возврата берём из PIPESTATUS[0] — иначе получим код tee, который всегда 0.
# Вызывать только в условии (if/||): внутри такого контекста errexit выключен,
# и падение сборки не уронит скрипт до того, как мы решим, что с ним делать.
run_tauri_bundle() {
  local log="$1" use_ci="$2" status
  (
    cd "$DESKTOP_DIR" || exit 1
    # CI=true заставляет tauri передать bundle_dmg.sh флаг --skip-jenkins, то
    # есть пропустить косметический AppleScript. Именно "true": на CI=1 tauri
    # CLI падает с «invalid value '1' for '--ci'».
    [ "$use_ci" = "ci" ] && export CI=true
    npm run tauri build -- --bundles app,dmg
  ) 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  return "$status"
}

# Признаки того, что упал не сам билд, а косметика: bundle_dmg.sh просит Finder
# разложить иконки в окне DMG через osascript, а у хост-процесса шелла нет
# разрешения Automation → Finder (агентские шеллы, ssh, CI, свежий терминал без
# выданного TCC-доступа). Строку про Apple events tauri показывает не всегда
# (вывод bundle_dmg.sh он глотает без --verbose), поэтому ловим и более общий
# «error running bundle_dmg.sh»: если дело было не в этом, повтор всё равно
# упадёт и мы честно сообщим об ошибке.
looks_like_apple_events_denial() {
  grep -qE 'Not authorised to send Apple events|Failed running AppleScript|-1743|error running bundle_dmg\.sh' "$1"
}

BUILD_LOG=""
cleanup_build_log() {
  [ -n "$BUILD_LOG" ] && rm -f "$BUILD_LOG"
  return 0
}
trap cleanup_build_log EXIT

run_build() {
  local version
  version="$(read_version)"
  step "Версия из tauri.conf.json: $version"

  BUILD_LOG="$(mktemp -t sdmp-build-dmg)" \
    || die "Не смог создать временный файл для лога сборки (mktemp упал)."

  clean_stale_rw_images

  step "Собираю .dmg и .app (npm run tauri build -- --bundles app,dmg)…"
  if run_tauri_bundle "$BUILD_LOG" ""; then
    :
  elif looks_like_apple_events_denial "$BUILD_LOG"; then
    echo
    warn "Сборка упала на упаковке DMG: macOS не дала обратиться к Finder (Apple events)."
    warn "Повторяю один раз с CI=true — оформление окна DMG (раскладка иконок) будет"
    warn "пропущено. На работоспособность .dmg и .app это не влияет."
    warn "Чтобы получить «красивый» DMG — выдай своему терминалу/IDE доступ в"
    warn "System Settings → Privacy & Security → Automation → Finder и собери заново."
    echo
    clean_stale_rw_images
    run_tauri_bundle "$BUILD_LOG" "ci" \
      || die "Повторная сборка с CI=true тоже упала — смотри вывод выше (дело не в Apple events)."
  else
    die "Сборка tauri упала — смотри вывод выше."
  fi

  echo

  # Имя .dmg ищем глобом, а не собираем строкой (SDMP_<version>_<arch>.dmg):
  # если tauri когда-нибудь поменяет схему имени, скрипт должен это заметить
  # и упасть с понятной причиной, а не молча разойтись с реальностью.
  # НЕ через `ls | head -1` — под pipefail это тот же SIGPIPE-капкан, что
  # разобран в dev-signing.sh:113-117 (`head` закрывает пайп раньше, чем `ls`
  # допишет вывод, `ls` получает SIGPIPE, pipefail валит код всей цепочки).
  # Массив-глоб этой ловушки не знает.
  #
  # Но глоб `*.dmg` слепо берёт первый файл по алфавиту — а в bundle/dmg/
  # может лежать чужой результат: (а) tauri удаляет только dmg с ТОЧНО
  # совпадающим именем, так что dmg прошлой версии остаётся рядом; (б) сам
  # tauri (bundle_dmg.sh, DMG_TEMP_NAME="$DMG_DIR/rw.$$.${DMG_NAME}") пишет
  # промежуточный rw-образ, который остаётся после прерванной сборки и тоже
  # подходит под *.dmg — а порядок глоба зависит от LC_COLLATE, так что
  # предсказать, что окажется первым, нельзя. Поэтому: отфильтровываем
  # `rw.*` явно и оставляем только файлы с текущей версией в имени; если
  # после этого — не ровно один файл, это тоже повод упасть, а не гадать.
  local nullglob_was_set=0
  shopt -q nullglob && nullglob_was_set=1
  shopt -s nullglob
  local dmgs=() f
  for f in "$SRC_TAURI_DIR"/target/release/bundle/dmg/*.dmg; do
    case "${f##*/}" in rw.*) continue ;; esac
    case "${f##*/}" in *"${version}"*) dmgs+=( "$f" ) ;; esac
  done
  (( nullglob_was_set )) || shopt -u nullglob
  (( ${#dmgs[@]} == 1 )) \
    || die "Ожидал ровно один .dmg версии ${version} в bundle/dmg/, нашёл ${#dmgs[@]}: ${dmgs[*]:-нет ни одного}"
  ok "dmg:  ${dmgs[0]}"

  local app_path="$SRC_TAURI_DIR/target/release/bundle/macos/SDMP.app"
  [ -e "$app_path" ] || die "Сборка прошла, но .app не найден: $app_path"
  ok "app:  $app_path"

  if [ "$RUN_APP" -eq 1 ]; then
    echo
    warn "Убедись, что backend уже поднят на http://localhost:8100 — приложение стучится туда."
    step "Открываю ${app_path}…"
    open "$app_path" || die "open вернул ошибку — launchd отказался открыть $app_path."
  else
    echo
    echo "Подсказка: передай --run, чтобы сразу открыть .app, или запусти вручную: open \"$app_path\""
  fi
}

preflight
if [ "$CHECK_ONLY" -eq 1 ]; then
  report_deps
  # read_version() сама объявлена как «провалидировать конфиг заранее» —
  # --check должен ловить битый tauri.conf.json тоже, а не только тулчейн
  # и node_modules.
  version_from_check="$(read_version)"
  ok "tauri.conf.json: version=$version_from_check — валиден."
  ok "Preflight пройден, --check — сборку не запускаю."
  exit 0
fi
install_deps
run_build
