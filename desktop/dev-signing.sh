#!/usr/bin/env bash
#
# Стабильная подпись отладочного бинарника — чтобы macOS перестала спрашивать
# пароль от связки ключей после каждой пересборки.
#
# ПОЧЕМУ ОНА СПРАШИВАЕТ. У каждого элемента связки ключей есть ACL — список
# программ, которым доступ разрешён, и программа в нём опознаётся по своей
# подписи. `cargo build` на Apple Silicon отдаёт бинарник с подписью
# `adhoc, linker-signed`: собственной личности у неё нет, роль личности играет
# CDHash — хеш самого кода. Меняешь строчку в Rust — меняется хеш — для системы
# это ДРУГАЯ программа, которой ничего не разрешали. Отсюда и вопрос после
# каждой сборки, и бесполезность кнопки «Always Allow»: она запомнила прошлый
# хеш.
#
# ЧТО ДЕЛАЕТ ЭТОТ СКРИПТ. Заводит самоподписанный сертификат для подписи кода и
# подписывает им отладочный бинарник. Теперь личность бинарника — сертификат, а
# не хеш кода: пересборка её не меняет. «Always Allow» нажимается один раз и
# держится.
#
# ЧЕГО ЭТОТ СКРИПТ НАМЕРЕННО НЕ ДЕЛАЕТ. Не открывает элемент связки «для всех
# программ» (`security -A`). Это второй способ убрать вопрос — и он означает,
# что мастер-ключ от ВСЕХ секретов пользователя сможет прочитать любой процесс
# на машине, включая случайно запущенный. Для продукта, который продаётся
# фразой «мы физически не можем прочитать твои секреты», это не компромисс, а
# отмена обещания.
#
# И не заводит «дев-режим без связки ключей». Ровно такой обход уже стоил нам
# рабочего продукта: `keyring` собирался с mock-хранилищем, «сохранено»
# отвечало `Ok`, ничего не сохранив, и ни один секрет нельзя было записать —
# при 191 зелёном тесте (коммит `26bf693`). Обход, из-за которого разработка
# перестаёт трогать настоящий механизм, ломает именно тот механизм, который
# обходит.
#
# Использование:
#   ./dev-signing.sh setup    # один раз: завести сертификат
#   ./dev-signing.sh sign     # после каждой `cargo build`
#   ./dev-signing.sh status   # чем подписан бинарник сейчас
#   ./dev-signing.sh remove   # убрать сертификат и откатить всё

set -euo pipefail

CERT_NAME="SDMP Dev Signing"
# Тот же идентификатор, что у приложения: он входит в требование, которое
# связка ключей запоминает в ACL. Разойдётся с бандлом — подпись будет считаться
# другой программой, и вопрос вернётся.
BUNDLE_ID="com.sdmp.desktop"
BINARY="$(cd "$(dirname "$0")" && pwd)/src-tauri/target/debug/sdmp-desktop"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

die() { echo "❌ $*" >&2; exit 1; }

cmd_setup() {
  if security find-certificate -c "$CERT_NAME" >/dev/null 2>&1; then
    echo "✅ Сертификат «${CERT_NAME}» уже есть — setup не нужен."
    return 0
  fi

  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  echo "→ Генерирую самоподписанный сертификат для подписи кода…"
  # `extendedKeyUsage=codeSigning` обязателен: без него `codesign` личность не
  # увидит, а `security find-identity -p codesigning` покажет ноль.
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
    -subj "/CN=$CERT_NAME/O=SDMP/C=US" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -addext "basicConstraints=critical,CA:false" \
    -addext "keyUsage=critical,digitalSignature" 2>/dev/null

  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
    -out "$tmp/dev.p12" -passout pass: -name "$CERT_NAME"

  echo "→ Кладу в связку ключей. macOS спросит пароль — это нормально."
  # `-T /usr/bin/codesign` разрешает утилите подписи пользоваться приватным
  # ключом без отдельного вопроса на каждую подпись.
  security import "$tmp/dev.p12" -k "$KEYCHAIN" -P "" \
    -T /usr/bin/codesign -T /usr/bin/security

  echo "→ Отмечаю сертификат доверенным для подписи кода."
  echo "   Появится системный запрос — подтверди его."
  # Без доверия `codesign` откажется: самоподписанный сертификат без явной
  # отметки для него невалиден.
  security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$tmp/cert.pem"

  echo
  echo "✅ Готово. Дальше: ./dev-signing.sh sign"
  echo "   При первом запуске подписанного бинарника связка ключей спросит ещё"
  echo "   раз — это последний раз. Нажми «Always Allow»."
}

cmd_sign() {
  [ -f "$BINARY" ] || die "Бинарника нет: $BINARY — сначала cargo build"
  # Через переменную, а не `| grep -q`: см. причину в `cmd_status`.
  local identities
  identities="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  [[ "$identities" == *"$CERT_NAME"* ]] \
    || die "Личности «${CERT_NAME}» нет. Сначала: ./dev-signing.sh setup"

  # `--force` — поверх adhoc-подписи, которую поставил линкер.
  # `--identifier` фиксируем явно: по умолчанию codesign берёт имя файла, а оно
  # с идентификатором приложения не совпадает.
  codesign --force --sign "$CERT_NAME" --identifier "$BUNDLE_ID" \
    --options runtime --timestamp=none "$BINARY"

  echo "✅ Подписан. Личность теперь не зависит от содержимого сборки."
  cmd_status
}

cmd_status() {
  [ -f "$BINARY" ] || die "Бинарника нет: $BINARY"
  # Вывод забираем В ПЕРЕМЕННУЮ, а не гоняем по пайпу дважды. С `grep -q` под
  # `pipefail` получалось наоборот: grep закрывает пайп на первом совпадении,
  # `codesign` ловит SIGPIPE и выходит с 141, pipefail отдаёт этот код всему
  # конвейеру — и условие «подпись adhoc» становилось ложным именно тогда,
  # когда она adhoc.
  local desc
  desc="$(codesign -dv "$BINARY" 2>&1 || true)"
  echo
  echo "── Чем подписан бинарник ──"
  echo "$desc" | grep -E "Identifier|Signature|Authority" || true
  echo
  if [[ "$desc" == *"Signature=adhoc"* ]]; then
    echo "⚠️  adhoc — личность равна хешу кода, связка ключей будет спрашивать"
    echo "   после каждой пересборки. Запусти: ./dev-signing.sh sign"
  else
    echo "✅ Подпись стабильная — «Always Allow» переживёт пересборку."
  fi
}

cmd_remove() {
  echo "→ Убираю доверие и сертификат…"
  security remove-trusted-cert "$CERT_NAME" 2>/dev/null || true
  security delete-certificate -c "$CERT_NAME" -t "$KEYCHAIN" 2>/dev/null \
    || echo "   (сертификата уже нет)"
  echo "✅ Убрано. Следующая cargo build вернёт adhoc-подпись."
}

case "${1:-}" in
  setup)  cmd_setup ;;
  sign)   cmd_sign ;;
  status) cmd_status ;;
  remove) cmd_remove ;;
  *)
    echo "Использование: $0 {setup|sign|status|remove}"
    echo
    echo "  setup   один раз: завести самоподписанный сертификат"
    echo "  sign    после каждой cargo build"
    echo "  status  чем подписан бинарник сейчас"
    echo "  remove  откатить всё"
    exit 1
    ;;
esac
