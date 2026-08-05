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
# ПОЧЕМУ ТОЛЬКО host-арка (aarch64). Universal-бинарь (aarch64+x86_64) —
# отдельная задача Stage 5; собирать его сейчас — YAGNI.
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

die() { echo "❌ $*" >&2; exit 1; }
step() { echo "→ $*"; }
ok() { echo "✅ $*"; }

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
  --check       выполнить только preflight-проверки тулчейна, без сборки
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

  # Без rustup таргет проверить нечем (тулчейн мог быть поставлен напрямую) —
  # в этом случае просто пропускаем проверку, а не падаем на ровном месте.
  if command -v rustup >/dev/null 2>&1; then
    local targets
    targets="$(rustup target list --installed 2>/dev/null || true)"
    [[ "$targets" == *"aarch64-apple-darwin"* ]] \
      || die "Таргет aarch64-apple-darwin не установлен. Выполни: rustup target add aarch64-apple-darwin"
  fi

  ok "Тулчейн на месте: cargo, rustc, node, npm, aarch64-apple-darwin."
}

# ── Зависимости ──────────────────────────────────────────────────────────
# desktop/node_modules нужен ради @tauri-apps/cli (иначе `npm run tauri`
# звать нечем). frontend/node_modules — отдельный кейс: beforeBuildCommand в
# tauri.conf.json дёргает `tsc && vite build`, и без node_modules сборка
# фронта упадёт ПОСЛЕ старта tauri build, с менее понятной ошибкой из недр
# tauri-cli. Решение: ставим оба одинаково — команда должна правда делать
# всё, а не половину, и это ровно тот edge case, что упомянут в плане.
install_deps() {
  if [ -d "$DESKTOP_DIR/node_modules" ]; then
    ok "desktop/node_modules уже на месте."
  else
    step "desktop/node_modules нет — ставлю (нужен @tauri-apps/cli)…"
    ( cd "$DESKTOP_DIR" && npm install )
    ok "desktop/node_modules установлен."
  fi

  if [ -d "$FRONTEND_DIR/node_modules" ]; then
    ok "frontend/node_modules уже на месте."
  else
    step "frontend/node_modules нет — ставлю…"
    ( cd "$FRONTEND_DIR" && npm install )
    ok "frontend/node_modules установлен."
  fi
}

# Версию приложения (а не версию npm-пакета оболочки из desktop/package.json)
# Tauri берёт из tauri.conf.json — оттуда же читаем и мы, чтобы имя .dmg не
# разъехалось с тем, что реально соберёт tauri-cli.
read_version() {
  [ -f "$TAURI_CONF" ] || die "Не найден $TAURI_CONF"
  node -e 'console.log(require(process.argv[1]).version)' "$TAURI_CONF"
}

run_build() {
  local version dmg_path app_path
  version="$(read_version)"
  dmg_path="$SRC_TAURI_DIR/target/release/bundle/dmg/SDMP_${version}_aarch64.dmg"
  app_path="$SRC_TAURI_DIR/target/release/bundle/macos/SDMP.app"

  step "Собираю .dmg (npm run tauri build -- --bundles dmg)…"
  ( cd "$DESKTOP_DIR" && npm run tauri build -- --bundles dmg )

  echo
  if [ -e "$dmg_path" ]; then
    ok "dmg:  $dmg_path"
  else
    echo "⚠️  Ожидаемый .dmg не найден: $dmg_path (возможно, версия или схема имени изменились)"
  fi
  if [ -e "$app_path" ]; then
    ok "app:  $app_path"
  else
    echo "⚠️  Ожидаемый .app не найден: $app_path"
  fi

  if [ "$RUN_APP" -eq 1 ]; then
    [ -e "$app_path" ] || die "Не могу открыть — $app_path не существует."
    echo
    echo "⚠️  Убедись, что backend уже поднят на http://localhost:8100 — приложение стучится туда."
    step "Открываю $app_path…"
    open "$app_path"
  else
    echo
    echo "Подсказка: передай --run, чтобы сразу открыть .app, или запусти вручную: open \"$app_path\""
  fi
}

preflight
if [ "$CHECK_ONLY" -eq 1 ]; then
  ok "Preflight пройден, --check — сборку не запускаю."
  exit 0
fi
install_deps
run_build
