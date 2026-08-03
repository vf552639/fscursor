# ADR: хранение TOTP-секрета в плейнтексте (временный компромисс)

**Дата:** 2026-08-02  **Статус:** принято (фаза «для себя»).

## Контекст

`users.totp_secret` (`backend/app/auth/models.py:21`) хранится открытым (`String(64)`), значение —
base32-seed от `pyotp.random_base32()`. Это seed серверной 2FA, а не пользовательский
ZK-секрет: SSH-пароли, FTP/DB-пароли и API-токены регистраторов и Cloudflare шифруются на
клиенте и лежат в `blob_storage` как непрозрачные ciphertext-блобы, а в доменных таблицах на
них остаются только ссылки `*_blob_id`.

При утечке БД seed ослабляет 2FA, но сам по себе входа не даёт: `POST /api/auth/login/finish`
(`backend/app/auth/routes.py:96`) сначала проверяет `auth_key`, а TOTP — вторым фактором.
`auth_key` выводится из пароля на клиенте (Argon2id, libsodium/dryoc `crypto_pwhash`,
opslimit 3, memlimit 64 MiB — `desktop/src-tauri/src/crypto/kdf.rs`) и на сервере хранится
только как bcrypt-хэш `users.auth_key_hash` (`backend/app/auth/crypto.py:12`).

## Решение

В текущей фазе (один пользователь, self-host) оставляем плейнтекст и документируем компромисс.
Схему БД не меняем.

## Триггер пересмотра (перед продуктовой фазой / мультиарендностью)

Зашифровать `totp_secret` app-level симметричным ключом (KEK из env / KMS), с миграцией
существующих значений и обработкой ротации ключа. Альтернатива — вынести 2FA в отдельный
провайдер. Тогда же закрыть смежные пункты:

- `POST /api/auth/totp/enable` (`backend/app/auth/routes.py:247`) возвращает seed в теле ответа
  и в `provisioning_uri`. Для первичной привязки это неизбежно, но ответ не должен попадать
  ни в какие серверные логи.
- Роут отключения 2FA отсутствует: включённый TOTP снимается только правкой БД.

## Область действия: чем это НЕ является

Это ADR про **один** столбец. Он не утверждает, что `totp_secret` — единственный плейнтекст-
секрет на сервере. По состоянию на 2026-08-02 их два, и второй серьёзнее:

`system_config.value` (`backend/app/models/system_config.py:23`) — `Text`, без шифрования. Среди
ключей `EDITABLE_KEYS` есть `Webhook Secret` и `Webhook URL`
(`backend/app/services/system_config_service.py:19-21`), которые сервер использует при доставке
уведомлений (`backend/app/services/notification_providers/dispatcher.py:29-31`). В отличие от
`totp_secret`, таблица `system_config` входит в `SCOPED_MODELS` (`backend/app/sync/routes.py:29`),
а `_to_row` сериализует все столбцы кроме `sync_version` / `sync_deleted` / `user_id` — значит
`Webhook Secret` в плейнтексте уходит каждому клиенту через `/api/sync/snapshot` и
`/api/sync/changes`, а также через `GET /api/settings/config`.

Это осознанно оставлено как есть, а не покрыто ZK: подпись вебхуков делается на сервере (Celery),
поэтому клиентское шифрование значения потребует переноса доставки в десктоп. Отдельный дефект —
`system_config_service.upsert` (`backend/app/services/system_config_service.py:76`) читает строку
по PK `key` без проверки владельца и переприсваивает `user_id` вызывающему; то же в
`ensure_defaults` (там же, `:45`). Оба пункта вынесены в бэклог и здесь только фиксируются.

## Проверка

Плейнтекст-секреты (по всему `backend/app`, а не только по `app/models` / `app/schemas` —
`totp_secret` живёт в `app/auth/models.py` и в узкий грep не попадает):

```bash
grep -rniE "password|secret|token|api_key" backend/app --include='*.py' \
  | grep -viE "blob_id|_hash|token_hash|blob_kind|totp_code"
```

Ожидание: в столбцах моделей секреты присутствуют только как `*_blob_id` или `*_hash`;
открытых два — `users.totp_secret` (покрыт этим ADR) и `system_config.value` (см. раздел выше).
Любая иная находка — дефект, завести отдельную задачу.

Что именно уходит клиентам (сериализация в `/api/sync/*` идёт по `obj.__table__.columns`,
то есть автоматически подхватывает любой новый столбец):

```bash
cd backend && python3.12 -c "
import app.models
from app.sync.routes import SCOPED_MODELS
skip = {'sync_version', 'sync_deleted', 'user_id'}
for t, m in SCOPED_MODELS.items():
    print(t, [c.name for c in m.__table__.columns if c.name not in skip])
"
```

Любой новый плейнтекст-столбец на синкаемой модели автоматически становится частью протокола
синхронизации — это ровно тот механизм, из-за которого `servers.notes` оказался реальной утечкой
(снят миграцией `012`). Добавляя столбец в синкаемую таблицу, проверяй его этим списком.

Аудит без секретов: `audit_service.log` (`backend/app/audit/service.py`) валидирует только
`action` по `SAFE_ACTIONS`; `metadata` пишется в `audit_log.metadata` как есть, серверного
редактора-guard'а нет. Автоматическая защита — только тест `backend/tests/test_mutation_audit.py`
(проверяет и имена ключей, и значения) и debug-only `debug_assert` на стороне десктопа
(`desktop/src-tauri/src/audit_redact.rs`). Seed TOTP в `audit_log` не попадает: `auth.totp_enable`
логируется без `metadata`.
