#!/usr/bin/env bash
#
# Собирает .dmg десктоп-приложения SDMP одной командой: проверяет тулчейн,
# ставит npm-зависимости (desktop/ и frontend/), гонит `tauri build` только
# для macOS-таргета и печатает пути к артефактам. С флагом --run ещё и
# открывает собранный .app.
#
# ПОЧЕМУ ТОЛЬКО --bundles dmg. В tauri.conf.json bundle.targets содержит
# ["dmg", "nsis", "appimage"] — Windows и Linux пока не наша задача (Stage 5,
# отложено намеренно). Без явного --bundles dmg `tauri build` попробует
# собрать все три и упадёт на отсутствующих Windows/Linux-тулчейнах.
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
  local host_target
  host_target="$(rustc -vV | awk '/^host:/{print $2}')"
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
handle_node_modules() {
  local dir="$1" label="$2" mode="$3"

  if [ -d "$dir/node_modules" ]; then
    ok "$label/node_modules уже на месте."
    return 0
  fi

  if [ "$mode" = "report" ]; then
    warn "$label/node_modules нет — при сборке будет установлен."
    return 0
  fi

  if [ -f "$dir/package-lock.json" ]; then
    step "$label/node_modules нет — ставлю по package-lock.json (npm ci)…"
    ( cd "$dir" && npm ci )
  else
    step "$label/node_modules нет, лок-файла тоже нет — ставлю (npm install)…"
    ( cd "$dir" && npm install )
  fi
  ok "$label/node_modules установлен."
}

install_deps() {
  handle_node_modules "$DESKTOP_DIR" "desktop" "install"
  handle_node_modules "$FRONTEND_DIR" "frontend" "install"
}

report_deps() {
  handle_node_modules "$DESKTOP_DIR" "desktop" "report"
  handle_node_modules "$FRONTEND_DIR" "frontend" "report"
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

run_build() {
  local version
  version="$(read_version)"
  step "Версия из tauri.conf.json: $version"

  step "Собираю .dmg (npm run tauri build -- --bundles dmg)…"
  ( cd "$DESKTOP_DIR" && npm run tauri build -- --bundles dmg ) \
    || die "Сборка tauri упала — смотри вывод выше."

  echo

  # Имя .dmg ищем глобом, а не собираем строкой (SDMP_<version>_<arch>.dmg):
  # если tauri когда-нибудь поменяет схему имени, скрипт должен это заметить
  # и упасть с понятной причиной, а не молча разойтись с реальностью.
  # НЕ через `ls | head -1` — под pipefail это тот же SIGPIPE-капкан, что
  # разобран в dev-signing.sh:113-117 (`head` закрывает пайп раньше, чем `ls`
  # допишет вывод, `ls` получает SIGPIPE, pipefail валит код всей цепочки).
  # Массив-глоб этой ловушки не знает.
  shopt -s nullglob
  local dmgs=( "$SRC_TAURI_DIR"/target/release/bundle/dmg/*.dmg )
  shopt -u nullglob
  (( ${#dmgs[@]} )) || die "Сборка прошла, но .dmg в bundle/dmg/ не появился."
  ok "dmg:  ${dmgs[0]}"

  local app_path="$SRC_TAURI_DIR/target/release/bundle/macos/SDMP.app"
  [ -e "$app_path" ] || die "Сборка прошла, но .app не найден: $app_path"
  ok "app:  $app_path"

  if [ "$RUN_APP" -eq 1 ]; then
    echo
    warn "Убедись, что backend уже поднят на http://localhost:8100 — приложение стучится туда."
    step "Открываю ${app_path}…"
    open "$app_path"
  else
    echo
    echo "Подсказка: передай --run, чтобы сразу открыть .app, или запусти вручную: open \"$app_path\""
  fi
}

preflight
if [ "$CHECK_ONLY" -eq 1 ]; then
  report_deps
  ok "Preflight пройден, --check — сборку не запускаю."
  exit 0
fi
install_deps
run_build
