# Спринт 2 — Безопасность / ZK-инварианты и очистка легаси: план реализации

> **Для агентов-исполнителей:** ОБЯЗАТЕЛЬНЫЙ ПОД-НАВЫК — используй
> `superpowers:subagent-driven-development` (рекомендуется) или `superpowers:executing-plans`,
> чтобы выполнять план задача-за-задачей. Шаги отмечены чекбоксами (`- [ ]`).

**Goal:** выполнить обещание zero-knowledge и убрать хвосты старой архитектуры: каждая мутация
пишется в `audit_log` без плейнтекст-секретов; на сервере не остаётся открытых секретных полей
(TOTP — задокументированный компромисс); удалён легаси SSL-email-pool; CSP вынесен из хардкода;
тексты и метаданные приведены к реальной крипто-модели.

**Architecture:** аудит остаётся server-side allow-list (`SAFE_ACTIONS`) — сначала расширяем список,
потом дописываем вызовы `audit_service.log(...)` в роуты-мутации (blob/settings/notifications) по
уже существующему паттерну (`servers.py`, `domains.py`, `auth/routes.py`). Удаление легаси идёт
согласованно: модель + сервис + схема + регистрация в `routes/__init__.py` + запись в
`sync.SCOPED_MODELS` + `models/__init__.py` + alembic-миграция `drop_table`/`drop_column` +
фронтенд. CSP параметризуется через механизм `envsubst` официального образа `nginx`.

**Tech Stack:** Python 3.12 (FastAPI, SQLAlchemy async, Alembic, pytest, httpx ASGI), TypeScript/
React 18 (vitest), nginx:alpine (envsubst-шаблоны), Docker Compose.

---

## Контекст и решения (зафиксировано с пользователем)

- **TOTP-секрет** (`backend/app/auth/models.py:21`, `totp_secret String(64)` в плейнтексте) —
  **документируем компромисс, шифрование откладываем**. Это seed серверной 2FA, а не пользовательский
  ZK-секрет (SSH/API-токен): при утечке БД он ослабляет 2FA, но сам по себе входа не даёт (нужен
  ещё `auth_key`, выводимый из пароля на клиенте). В фазе «для себя» (один пользователь, self-host)
  достаточно ADR + комментария в модели с триггером «зашифровать перед продуктовой фазой». Схему БД
  не трогаем.
- **FastPanel-метаданные** (`server.fastpanel_*`) — **оставляем используемые, убираем только реально
  мёртвые**. Спринт 1 реализовал `install_fastpanel`, и фронт активно читает
  `fastpanel_status/url/user/version/port/password_blob_id` (Servers, Dashboard, ServerDetail,
  deepLink, Activity). Задача превращается в grep-верификацию: удаляем поле только при нуле осмысленных
  чтений (Task 10).
- **SSL-email-pool удаляем целиком** — пользователь заводит данные вручную, пул не нужен. Удаление
  затрагивает больше файлов, чем предполагал стратегический план: таблица `ssl_email_pool` вшита в
  sync-протокол (`SCOPED_MODELS`) и в `models/__init__.py`, поэтому нужна согласованная правка +
  alembic `drop_table` (Task 8).
- **server.notes удаляем** (не переносим в blob): в UI поле нигде не отображается, используется только
  в bulk-import CSV (колонка 6) и типах фронта. Простое удаление + `drop_column` (Task 6).
- **Объём** — только Спринт 2. Продуктовая фаза (Stage 5) остаётся отдельным заделом.

## Философия тестирования (важно прочитать до старта)

Кодовая база задаёт паттерны: backend-роуты покрываются интеграционными тестами через httpx
ASGI-клиент (`backend/tests/test_blobs.py`, `test_audit.py` — регистрация→подтверждение→логин→запрос
→проверка `audit_log`); чистая логика (парсеры, наборы констант) — обычными `pytest`/`vitest`;
тонкие обёртки над внешними эффектами (Celery `.delay()`, доставка в webhook/telegram), которые
нельзя честно замокать без брокера, — проверяются ручным чек-листом, а не выдуманным тестом.

Поэтому в плане: audit-набор (`SAFE_ACTIONS`), audit на blob/settings/mark-read/delete, парсер
bulk-import, набор `ENCRYPTION_INFO` — покрываем настоящими тестами. `notification.check_renewals`
(дёргает Celery) и nginx-CSP — ручная проверка. Это осознанное следование паттернам репозитория.

Базовые команды прогонки:
- Backend: `cd backend && python3.12 -m pytest tests/<файл> -v`
- Frontend: `cd frontend && npx vitest run <путь>` / `npx tsc --noEmit`
- Миграции: `cd backend && python3.12 -m alembic upgrade head` (на dev-БД)

---

## File Structure

**Создаются:**
- `backend/alembic/versions/012_drop_server_notes.py` — миграция: `drop_column servers.notes`.
- `backend/alembic/versions/013_drop_ssl_email_pool.py` — миграция: `drop_table ssl_email_pool`.
- `backend/tests/test_mutation_audit.py` — интеграционные тесты: blob/settings/notifications пишут audit.
- `docs/security/TOTP_STORAGE.md` — ADR по плейнтекст-TOTP (компромисс + триггер шифрования).
- `frontend/src/pages/settingsEncryptionInfo.ts` + `.test.ts` — корректный набор строк вкладки Encryption.

**Модифицируются:**
- `backend/app/audit/service.py` — расширить `SAFE_ACTIONS` мутационными действиями.
- `backend/tests/test_audit_actions.py` — тест на новые мутационные действия.
- `backend/app/blobs/routes.py` — audit в PUT/DELETE.
- `backend/app/api/routes/settings.py` — audit в `update_config` / `test_notification_delivery`.
- `backend/app/api/routes/notifications.py` — audit в `mark_read` / `delete` / `check-renewals`.
- `backend/app/auth/models.py` — комментарий-компромисс над `totp_secret`.
- `backend/app/models/server.py`, `backend/app/schemas/server.py`,
  `backend/app/services/bulk_import_service.py` — убрать `notes`.
- `frontend/src/api/servers.ts`, `frontend/src/components/ServerBulkImportDialog.tsx` — убрать `notes`.
- `nginx/nginx.conf` → `nginx/nginx.conf.template` + `docker-compose.yml` + `.env.example` — CSP из env.
- `backend/app/api/routes/__init__.py`, `backend/app/sync/routes.py`,
  `backend/app/models/__init__.py` — снять регистрацию `ssl_email_pool`.
- **Удаляются:** `backend/app/api/routes/ssl_emails.py`, `backend/app/services/ssl_email_service.py`,
  `backend/app/models/ssl_email.py`, `backend/app/schemas/ssl_email.py`, `frontend/src/api/sslEmails.ts`.
- `frontend/src/pages/Settings.tsx` — убрать вкладку SSL Pool; починить вкладку Encryption.

---

## Task 1: Audit — расширить `SAFE_ACTIONS` мутационными действиями

Инвариант «любая мутация → audit_log» требует allow-list новых действий ДО того, как роуты начнут их
логировать (`audit_service.log` бросает `ValueError` на неизвестном action).

**Files:**
- Test: `backend/tests/test_audit_actions.py`
- Modify: `backend/app/audit/service.py:8-31`

- [ ] **Step 1: Дописать падающий тест**

В конец `backend/tests/test_audit_actions.py` добавить:

```python
MUTATION_AUDIT_ACTIONS = [
    "blob.upsert",
    "blob.delete",
    "settings.config_update",
    "settings.notification_test",
    "notification.mark_read",
    "notification.delete",
    "notification.check_renewals",
]


def test_mutation_actions_are_in_safe_actions():
    from app.audit.service import SAFE_ACTIONS

    for action in MUTATION_AUDIT_ACTIONS:
        assert action in SAFE_ACTIONS, f"{action} must be allow-listed"
```

- [ ] **Step 2: Прогнать тест — убедиться, что падает**

Run: `cd backend && python3.12 -m pytest tests/test_audit_actions.py -v`
Expected: FAIL — новых действий нет в `SAFE_ACTIONS`.

- [ ] **Step 3: Добавить действия в `SAFE_ACTIONS`**

В `backend/app/audit/service.py`, внутрь `frozenset({...})`, после строки `"auth.totp_enable",`
(строка 29) добавить:

```python
        "blob.upsert",
        "blob.delete",
        "settings.config_update",
        "settings.notification_test",
        "notification.mark_read",
        "notification.delete",
        "notification.check_renewals",
```

- [ ] **Step 4: Прогнать тест — убедиться, что проходит**

Run: `cd backend && python3.12 -m pytest tests/test_audit_actions.py -v`
Expected: PASS (все тесты файла зелёные).

- [ ] **Step 5: Коммит**

```bash
git add backend/app/audit/service.py backend/tests/test_audit_actions.py
git commit -m "feat(audit): allow-list blob/settings/notification mutation actions"
```

---

## Task 2: Blob-мутации пишут audit

`blobs/routes.py` PUT/DELETE меняют хранилище секретов, но не логируются. Добавляем audit по паттерну
`servers.py` (без коммита внутри `log`, коммит — отдельно). В metadata только `blob_kind` (метка вида,
не секрет); ciphertext никогда не логируется.

**Files:**
- Modify: `backend/app/blobs/routes.py`

- [ ] **Step 1: Добавить импорты**

В шапку `backend/app/blobs/routes.py` (после строки 5 `from fastapi import ...`) заменить импорт
fastapi и добавить audit:

```python
from fastapi import APIRouter, Depends, HTTPException, Request, status
```

После строки 13 (`from app.sync.service import bump_version`) добавить:

```python
from app.audit import service as audit_service
```

- [ ] **Step 2: Логировать `blob.upsert`**

В `upsert_blob` добавить параметр `request: Request` (после `body: BlobUpsert`, до `user=Depends`):

```python
async def upsert_blob(
    blob_id: uuid.UUID,
    body: BlobUpsert,
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> BlobResponse:
```

Перед `await db.commit()` (строка 68) вставить:

```python
    await audit_service.log(
        db,
        user_id=user.id,
        action="blob.upsert",
        target_type="blob",
        target_id=str(blob_id),
        device_id=body.device_id,
        ip=request.client.host if request.client else None,
        metadata={"blob_kind": body.blob_kind},
    )
```

- [ ] **Step 3: Логировать `blob.delete`**

В `delete_blob` добавить `request: Request` (после `blob_id`, до `user=Depends`):

```python
async def delete_blob(
    blob_id: uuid.UUID,
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> None:
```

Перед финальным `await db.commit()` (строка 98) вставить:

```python
    await audit_service.log(
        db,
        user_id=user.id,
        action="blob.delete",
        target_type="blob",
        target_id=str(blob_id),
        ip=request.client.host if request.client else None,
        metadata={"blob_kind": b.blob_kind},
    )
```

- [ ] **Step 4: Проверить существующие тесты blobs**

Run: `cd backend && python3.12 -m pytest tests/test_blobs.py -v`
Expected: PASS (2 существующих теста зелёные — контракт PUT/GET/DELETE не изменился).

- [ ] **Step 5: Коммит**

```bash
git add backend/app/blobs/routes.py
git commit -m "feat(audit): log blob upsert/delete mutations (no plaintext in metadata)"
```

---

## Task 3: Settings-мутации пишут audit

`update_config` (PUT config) и `test_notification_delivery` (POST notifications/test) — мутации/
побочные эффекты без аудита. В metadata `update_config` кладём только `key` (без `value` — значения
конфигов вроде webhook-URL полусенситивны).

**Files:**
- Modify: `backend/app/api/routes/settings.py`

- [ ] **Step 1: Добавить импорты**

Заменить строку 1 на:

```python
from fastapi import APIRouter, Depends, HTTPException, Request, status
```

После строки 9 (`from app.services import system_config_service`) добавить:

```python
from app.audit import service as audit_service
```

- [ ] **Step 2: Логировать `settings.config_update`**

В `update_config` добавить `request: Request` (после `payload: ConfigUpdate`, до `user=Depends`):

```python
async def update_config(
    key: str,
    payload: ConfigUpdate,
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> ConfigItem:
```

После строки `item = await system_config_service.upsert(db, key, payload.value, user.id)`
(строка 62) вставить:

```python
    await audit_service.log(
        db,
        user_id=user.id,
        action="settings.config_update",
        target_type="settings",
        target_id=key,
        ip=request.client.host if request.client else None,
        metadata={"key": key},
    )
    await db.commit()
```

- [ ] **Step 3: Логировать `settings.notification_test`**

В `test_notification_delivery` добавить `request: Request` (после `payload: NotificationTestRequest`):

```python
async def test_notification_delivery(
    payload: NotificationTestRequest,
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> NotificationTestResponse:
```

Перед `return NotificationTestResponse(...)` (строка 84) вставить:

```python
    await audit_service.log(
        db,
        user_id=user.id,
        action="settings.notification_test",
        target_type="settings",
        ip=request.client.host if request.client else None,
        metadata={"webhook": result.get("webhook", "disabled"),
                  "telegram": result.get("telegram", "disabled")},
    )
    await db.commit()
```

- [ ] **Step 4: Проверить компиляцию импортов**

Run: `cd backend && python3.12 -c "import app.api.routes.settings"`
Expected: без ошибок импорта. (Полный тест — в Task 5.)

- [ ] **Step 5: Коммит**

```bash
git add backend/app/api/routes/settings.py
git commit -m "feat(audit): log settings config-update and notification-test"
```

---

## Task 4: Notifications-мутации пишут audit

`mark_read`, `delete_notification`, `check-renewals` — мутации без аудита. `mark_read` логируем один
раз на вызов (в metadata — счётчик), а не по каждому уведомлению.

**Files:**
- Modify: `backend/app/api/routes/notifications.py`

- [ ] **Step 1: Добавить импорты**

Заменить строку 3 на:

```python
from fastapi import APIRouter, Depends, Query, Request, status
```

После строки 14 (`from app.services import notification_service`) добавить:

```python
from app.audit import service as audit_service
```

- [ ] **Step 2: Логировать `notification.mark_read`**

В `mark_read` добавить `request: Request` (после `payload`):

```python
async def mark_read(
    payload: NotificationMarkReadRequest,
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
```

Перед `return {"updated": updated}` (строка 53) вставить:

```python
    await audit_service.log(
        db,
        user_id=user.id,
        action="notification.mark_read",
        target_type="notification",
        ip=request.client.host if request.client else None,
        metadata={"count": updated, "ids": payload.ids or "all"},
    )
    await db.commit()
```

- [ ] **Step 3: Логировать `notification.delete`**

В `delete_notification` добавить `request: Request` (после `notification_id: int`):

```python
async def delete_notification(
    notification_id: int,
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> None:
    await notification_service.delete_notification(db, user.id, notification_id)
    await audit_service.log(
        db,
        user_id=user.id,
        action="notification.delete",
        target_type="notification",
        target_id=str(notification_id),
        ip=request.client.host if request.client else None,
    )
    await db.commit()
```

- [ ] **Step 4: Логировать `notification.check_renewals`**

Заменить весь `trigger_check_renewals` (строки 65-71) на версию с `db`/`request`/audit:

```python
@router.post("/check-renewals", status_code=status.HTTP_202_ACCEPTED)
async def trigger_check_renewals(
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    task = check_domain_renewals.delay()
    await audit_service.log(
        db,
        user_id=user.id,
        action="notification.check_renewals",
        ip=request.client.host if request.client else None,
        metadata={"task_id": task.id},
    )
    await db.commit()
    return {"task_id": task.id}
```

- [ ] **Step 5: Проверить компиляцию импортов**

Run: `cd backend && python3.12 -c "import app.api.routes.notifications"`
Expected: без ошибок импорта.

- [ ] **Step 6: Коммит**

```bash
git add backend/app/api/routes/notifications.py
git commit -m "feat(audit): log notification mark-read/delete/check-renewals"
```

---

## Task 5: Интеграционные тесты аудита мутаций

Проверяем end-to-end: после мутации в `/api/audit/log` появляется соответствующее действие, а в
metadata нет ключей с `password`/`token`. Тесты идут по паттерну `test_blobs.py`/`test_audit.py`.
`check_renewals` не покрываем (дёргает Celery-брокер) — оно проверяется вручную (Step 5).

**Files:**
- Create: `backend/tests/test_mutation_audit.py`

- [ ] **Step 1: Написать тесты**

Создать `backend/tests/test_mutation_audit.py`:

```python
import base64
import uuid as uuid_mod
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _register_confirm_login(client: AsyncClient, email: str) -> None:
    await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
        },
    )
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(b"\x01" * 32)},
    )


async def _audit_actions(client: AsyncClient) -> set[str]:
    r = await client.get("/api/audit/log")
    assert r.status_code == 200
    # ни в одной записи metadata нет плейнтекст-секретов
    for row in r.json():
        for k in (row.get("metadata") or {}):
            assert "password" not in k.lower()
            assert "token" not in k.lower()
    return {row["action"] for row in r.json()}


@pytest.mark.asyncio
async def test_blob_mutations_are_audited():
    bid = str(uuid_mod.uuid4())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"maud-blob-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.put(
            f"/api/blobs/{bid}",
            json={"blob_kind": "ssh_password", "ciphertext_b64": b64(b"secret")},
        )
        assert r.status_code == 200
        r = await c.delete(f"/api/blobs/{bid}")
        assert r.status_code == 204
        actions = await _audit_actions(c)
        assert "blob.upsert" in actions
        assert "blob.delete" in actions


@pytest.mark.asyncio
async def test_settings_config_update_is_audited():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"maud-set-{uuid_mod.uuid4().hex[:8]}@example.com")
        cfg = await c.get("/api/settings/config")
        assert cfg.status_code == 200
        editable = next((i for i in cfg.json() if i["editable"]), None)
        assert editable is not None, "need at least one editable config key"
        r = await c.put(
            f"/api/settings/config/{editable['key']}",
            json={"value": editable["value"]},
        )
        assert r.status_code == 200
        actions = await _audit_actions(c)
        assert "settings.config_update" in actions


@pytest.mark.asyncio
async def test_notification_mark_read_is_audited():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"maud-ntf-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/notifications/mark-read", json={})
        assert r.status_code == 200
        actions = await _audit_actions(c)
        assert "notification.mark_read" in actions
```

- [ ] **Step 2: Прогнать — убедиться, что проходит**

Run: `cd backend && python3.12 -m pytest tests/test_mutation_audit.py -v`
Expected: PASS (3 теста). Если `settings/config` пуст (нет editable-ключей на новом пользователе) —
тест сообщит явным assert'ом; тогда сначала выставить дефолтные ключи через существующий механизм и
повторить.

- [ ] **Step 3: Прогнать весь backend — регрессий нет**

Run: `cd backend && python3.12 -m pytest -q`
Expected: все тесты зелёные.

- [ ] **Step 4: Ручная проверка `check_renewals` (нужен Redis/Celery)**

При поднятом стеке: `POST /api/notifications/check-renewals` → 202; в `/api/audit/log` появляется
`notification.check_renewals` с `task_id` в metadata.

- [ ] **Step 5: Коммит**

```bash
git add backend/tests/test_mutation_audit.py
git commit -m "test(audit): integration coverage for blob/settings/notification mutations"
```

---

## Task 6: Убрать открытый `server.notes`

Свободный незашифрованный текст на сервере противоречит ZK. В UI поле не отображается; используется
только в bulk-import (CSV колонка 6) и типах. Удаляем поле + колонку.

**Files:**
- Modify: `backend/app/models/server.py:43`, `backend/app/schemas/server.py:16,36`
- Modify: `backend/app/services/bulk_import_service.py`
- Modify: `frontend/src/api/servers.ts:19,58,75`, `frontend/src/components/ServerBulkImportDialog.tsx:53`
- Create: `backend/alembic/versions/012_drop_server_notes.py`

- [ ] **Step 1: Обновить парсер bulk-import (тест — контракт CSV)**

Сначала правим тест-ожидание парсера. В `bulk_import_service.py`:

1. В dataclass `ServerImportRow` удалить поле `notes: Optional[str]`.
2. В `_parse_row` удалить строку `notes = str(row[5] ...)` и убрать `notes=notes or None` из
   конструктора `ServerImportRow(...)`.
3. В создании payload убрать `notes=item.notes`:

```python
        payload = ServerCreate(
            name=item.name,
            ip_address=item.ip,
            ssh_user=item.ssh_user,
            ssh_port=item.ssh_port,
        )
```

- [ ] **Step 2: Убрать `notes` из модели и схем**

1. `backend/app/models/server.py` — удалить строку 43 (`notes: Mapped[Optional[str]] = mapped_column(Text)`).
   Если после этого `Text` больше не используется в файле — убрать его из импорта sqlalchemy.
2. `backend/app/schemas/server.py` — удалить `notes: Optional[str] = None` из `ServerBase` (строка 16)
   и `notes: Optional[str] = None` из `ServerUpdate` (строка 36).

- [ ] **Step 3: Убрать `notes` на фронте**

1. `frontend/src/api/servers.ts` — удалить три строки с `notes` (19, 58, 75).
2. `frontend/src/components/ServerBulkImportDialog.tsx:53` — обновить подсказку формата CSV:

```tsx
          Format: <code>name,ip,ssh_user,ssh_password,ssh_port</code>
```

- [ ] **Step 4: Миграция — drop column**

Создать `backend/alembic/versions/012_drop_server_notes.py`:

```python
"""zk cleanup: drop plaintext servers.notes

Revision ID: 012_drop_server_notes
Revises: 011_zero_knowledge_v1
Create Date: 2026-08-02
"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "012_drop_server_notes"
down_revision: Optional[str] = "011_zero_knowledge_v1"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.drop_column("servers", "notes")


def downgrade() -> None:
    op.add_column("servers", sa.Column("notes", sa.Text(), nullable=True))
```

- [ ] **Step 5: Проверить типы/тесты**

Run: `cd backend && python3.12 -m pytest -q`
Expected: зелёные (модель/схемы согласованы).
Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок типов (нет обращений к `.notes`).

- [ ] **Step 6: Применить миграцию (dev-БД) и коммит**

```bash
cd backend && python3.12 -m alembic upgrade head
```
Expected: `012_drop_server_notes` применяется без ошибок.

```bash
git add backend/app/models/server.py backend/app/schemas/server.py \
  backend/app/services/bulk_import_service.py backend/alembic/versions/012_drop_server_notes.py \
  frontend/src/api/servers.ts frontend/src/components/ServerBulkImportDialog.tsx
git commit -m "refactor: drop plaintext server.notes (zk hygiene)"
```

---

## Task 7: nginx CSP — вынести origin из хардкода

`nginx/nginx.conf:11` жёстко прописывает `connect-src ... http://localhost:8100`. Переводим на
`envsubst`-шаблон официального образа `nginx`: шаблон в `/etc/nginx/templates/*.template`
подставляется entrypoint'ом до старта. `NGINX_ENVSUBST_FILTER` ограничивает подстановку только нашей
переменной, чтобы nginx-переменные (`$host`, `$http_upgrade`, …) не пострадали.

**Files:**
- Rename+modify: `nginx/nginx.conf` → `nginx/nginx.conf.template`
- Modify: `docker-compose.yml:63-72`
- Create/Modify: `.env.example`

- [ ] **Step 1: Переименовать конфиг в шаблон и параметризовать CSP**

```bash
git mv nginx/nginx.conf nginx/nginx.conf.template
```

В `nginx/nginx.conf.template` заменить строку 11 (CSP) на:

```nginx
        add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${WEB_CSP_CONNECT_SRC}; img-src 'self' data:; frame-ancestors 'none'" always;
```

- [ ] **Step 2: Обновить сервис nginx в `docker-compose.yml`**

Заменить блок `nginx:` (строки 63-72) на:

```yaml
  nginx:
    image: nginx:alpine
    volumes:
      - ./nginx/nginx.conf.template:/etc/nginx/templates/nginx.conf.template:ro
    environment:
      WEB_CSP_CONNECT_SRC: ${WEB_CSP_CONNECT_SRC:-http://localhost:8100}
      NGINX_ENVSUBST_OUTPUT_DIR: /etc/nginx
      NGINX_ENVSUBST_FILTER: "WEB_CSP_CONNECT_SRC"
    ports:
      - "8080:80"
    depends_on:
      - backend
      - frontend
    networks: [app-net]
```

(`NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx` + имя шаблона `nginx.conf.template` → рендер в
`/etc/nginx/nginx.conf`, сохраняя single-file-стиль конфига.)

- [ ] **Step 3: Задокументировать переменную в `.env.example`**

Добавить в `.env.example` (создать, если файла нет) строку:

```dotenv
# Origin(ы), разрешённые в CSP connect-src для веб-панели (через nginx).
# Для локалки: http://localhost:8100 ; для прод — реальный origin API.
WEB_CSP_CONNECT_SRC=http://localhost:8100
```

- [ ] **Step 4: Ручная проверка рендеринга CSP**

```bash
docker compose up -d nginx
docker compose exec nginx cat /etc/nginx/nginx.conf | grep Content-Security-Policy
```
Expected: в отрендеренном конфиге подставлен `http://localhost:8100`; nginx-переменные (`$host`,
`$http_upgrade`, `$proxy_add_x_forwarded_for`, `$http_x_request_id`) остались нетронутыми.
Затем: `WEB_CSP_CONNECT_SRC=https://panel.example.com docker compose up -d nginx` → в конфиге новый
origin. `docker compose exec nginx nginx -t` → syntax is ok.

- [ ] **Step 5: Коммит**

```bash
git add nginx/nginx.conf.template docker-compose.yml .env.example
git commit -m "fix(nginx): parametrize CSP connect-src via env (envsubst template)"
```

---

## Task 8: Удалить легаси SSL-email-pool (backend + frontend + миграция)

Пул не нужен (ручной ввод). Удаляем модель/сервис/схему/роут, снимаем регистрацию в
`routes/__init__.py`, `models/__init__.py` и `sync.SCOPED_MODELS`, дропаем таблицу `ssl_email_pool`,
чистим фронт. Тесты на `ssl_email_pool` в репозитории отсутствуют (grep пуст), но прогон всего
backend в конце обязателен.

**Files:**
- Delete: `backend/app/api/routes/ssl_emails.py`, `backend/app/services/ssl_email_service.py`,
  `backend/app/models/ssl_email.py`, `backend/app/schemas/ssl_email.py`, `frontend/src/api/sslEmails.ts`
- Modify: `backend/app/api/routes/__init__.py`, `backend/app/models/__init__.py`,
  `backend/app/sync/routes.py`, `frontend/src/pages/Settings.tsx`
- Create: `backend/alembic/versions/013_drop_ssl_email_pool.py`

- [ ] **Step 1: Снять регистрацию роутера**

`backend/app/api/routes/__init__.py`:
1. Удалить строку `from app.api.routes.ssl_emails import router as ssl_emails_router`.
2. Удалить строку `api_router.include_router(ssl_emails_router)`.

- [ ] **Step 2: Снять модель из sync и общего реестра**

1. `backend/app/sync/routes.py`: удалить импорт `from app.models.ssl_email import SslEmail` (строка 15)
   и запись `"ssl_email_pool": SslEmail,` из `SCOPED_MODELS` (строка 32).
2. `backend/app/models/__init__.py`: удалить импорт `from app.models.ssl_email import SslEmail`
   (строка 7) и строку `"SslEmail",` из `__all__` (строка 18).

- [ ] **Step 3: Удалить файлы модели/сервиса/схемы/роута/фронт-API**

```bash
git rm backend/app/api/routes/ssl_emails.py \
  backend/app/services/ssl_email_service.py \
  backend/app/models/ssl_email.py \
  backend/app/schemas/ssl_email.py \
  frontend/src/api/sslEmails.ts
```

- [ ] **Step 4: Убрать вкладку SSL Pool из `Settings.tsx`**

В `frontend/src/pages/Settings.tsx`:
1. Удалить импорт `import { useCreateSslEmail, useDeleteSslEmail, usePatchSslEmail, useSslEmails } from "../api/sslEmails";` (строка 5).
2. Удалить инстанцирование этих хуков (строки ~17-20) и `const sslEmails = sslEmailsData || [];` (строка ~23).
3. Удалить state `showAddSslEmail`, `newSslEmail`, `newSslCap` (строки ~35-37).
4. Удалить элемент таба `["ssl_pool","✉ SSL Pool"]` из массива на строке ~94.
5. Удалить весь JSX-блок `tab==="ssl_pool"` (строки ~178-260, включая модалку Add SSL Email).

- [ ] **Step 5: Миграция — drop table**

Создать `backend/alembic/versions/013_drop_ssl_email_pool.py`:

```python
"""zk cleanup: drop legacy ssl_email_pool

Revision ID: 013_drop_ssl_email_pool
Revises: 012_drop_server_notes
Create Date: 2026-08-02
"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "013_drop_ssl_email_pool"
down_revision: Optional[str] = "012_drop_server_notes"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.drop_table("ssl_email_pool")


def downgrade() -> None:
    op.create_table(
        "ssl_email_pool",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("user_id", postgresql_uuid(), nullable=True, index=True),
        sa.Column("sync_version", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("sync_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("email", sa.String(length=255), nullable=False, unique=True),
        sa.Column("usage_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("usage_cap", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )


def postgresql_uuid():
    from sqlalchemy.dialects.postgresql import UUID

    return UUID(as_uuid=True)
```

- [ ] **Step 6: Прогнать backend/фронт и применить миграцию**

Run: `cd backend && python3.12 -m pytest -q`
Expected: зелёные (нет упоминаний удалённой модели).
Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: без ошибок типов; тесты зелёные.
Run: `cd backend && python3.12 -m alembic upgrade head`
Expected: `013_drop_ssl_email_pool` применяется; таблица удалена.

- [ ] **Step 7: Коммит**

```bash
git add -A
git commit -m "chore: remove legacy ssl-email-pool (routes/model/service/schema/sync/UI + drop table)"
```

---

## Task 9: Починить текст вкладки Encryption (реальная крипто-модель)

Вкладка Encryption в `Settings.tsx` описывает несуществующую модель (AES-256-GCM / ENCRYPTION_KEY /
SHA-256). Реально — Argon2id + XChaCha20-Poly1305 (libsodium secretbox), шифрование на клиенте,
сервер хранит непрозрачные blob'ы. Выносим тексты в тестируемый модуль и правим их.

**Files:**
- Create: `frontend/src/pages/settingsEncryptionInfo.ts` + `frontend/src/pages/settingsEncryptionInfo.test.ts`
- Modify: `frontend/src/pages/Settings.tsx` (вкладка Encryption, строки ~306-326)

- [ ] **Step 1: Написать падающий тест**

Создать `frontend/src/pages/settingsEncryptionInfo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ENCRYPTION_BANNER, ENCRYPTION_INFO } from "./settingsEncryptionInfo";

describe("ENCRYPTION_INFO", () => {
  const flat = JSON.stringify([ENCRYPTION_BANNER, ...ENCRYPTION_INFO]);

  it("describes the real zero-knowledge model", () => {
    expect(flat).toContain("Argon2id");
    expect(flat).toContain("XChaCha20-Poly1305");
  });

  it("does not mention the obsolete AES/ENCRYPTION_KEY model", () => {
    expect(flat).not.toContain("AES-256-GCM");
    expect(flat).not.toContain("ENCRYPTION_KEY");
    expect(flat).not.toContain("SHA-256");
  });
});
```

- [ ] **Step 2: Прогнать — убедиться, что падает**

Run: `cd frontend && npx vitest run src/pages/settingsEncryptionInfo.test.ts`
Expected: FAIL — модуль `settingsEncryptionInfo` не существует.

- [ ] **Step 3: Создать модуль с корректными текстами**

Создать `frontend/src/pages/settingsEncryptionInfo.ts`:

```ts
export const ENCRYPTION_BANNER = {
  title: "Zero-Knowledge Encryption Active",
  body:
    "Secrets are encrypted on your device before upload. The master key is derived from your " +
    "password with Argon2id and never leaves the client — the server stores only opaque ciphertext.",
};

export const ENCRYPTION_INFO: ReadonlyArray<readonly [string, string]> = [
  ["Key Derivation", "Argon2id (client-side, from your password)"],
  ["Encryption", "XChaCha20-Poly1305 (libsodium secretbox)"],
  ["Where", "Encrypted on the desktop client before it reaches the server"],
  ["Server sees", "Opaque ciphertext blobs + metadata only"],
  ["Zero-knowledge", "Master key never leaves the client; server cannot decrypt"],
];
```

- [ ] **Step 4: Прогнать — убедиться, что проходит**

Run: `cd frontend && npx vitest run src/pages/settingsEncryptionInfo.test.ts`
Expected: PASS (2 теста).

- [ ] **Step 5: Использовать модуль во вкладке Encryption**

В `frontend/src/pages/Settings.tsx`:
1. Добавить импорт (рядом с прочими импортами страницы):

```tsx
import { ENCRYPTION_BANNER, ENCRYPTION_INFO } from "./settingsEncryptionInfo";
```

2. В блоке `tab==="encryption"` (строки ~306-326) заменить захардкоженные заголовок/описание баннера
   на `ENCRYPTION_BANNER.title` / `ENCRYPTION_BANNER.body`, а массив пар таблицы — на
   `ENCRYPTION_INFO.map(([k, v]) => (...))`. Разметку/классы сохранить как были (меняем только тексты
   и источник данных).

- [ ] **Step 6: Проверить типы и коммит**

Run: `cd frontend && npx tsc --noEmit`
Expected: без ошибок.

```bash
git add frontend/src/pages/settingsEncryptionInfo.ts frontend/src/pages/settingsEncryptionInfo.test.ts frontend/src/pages/Settings.tsx
git commit -m "fix(frontend): correct Encryption tab to Argon2id + XChaCha20-Poly1305 (zk)"
```

---

## Task 10: FastPanel-метаданные — верификация «мёртвых» полей

По решению пользователя: оставить используемые поля, удалить только реально неиспользуемые. Задача —
grep-gate: подтвердить фактические чтения/записи каждого `fastpanel_*` поля и удалить лишь те, у кого
ноль осмысленных обращений. По результатам разведки все поля читаются фронтом (status/url/user →
Servers/Dashboard/ServerDetail; version/port → ServerDetail; password_blob_id → RevealSecret), поэтому
ожидаемый исход — «удалять нечего», но проверку выполняем явно и фиксируем вывод.

**Files:**
- (Проверка; правки — только если grep докажет мёртвое поле.)

- [ ] **Step 1: Собрать карту использования каждого поля**

```bash
for f in fastpanel_status fastpanel_url fastpanel_user fastpanel_version fastpanel_port fastpanel_password_blob_id; do
  echo "=== $f ==="; grep -rn "$f" backend/app frontend/src --include=*.py --include=*.ts --include=*.tsx | grep -v "alembic";
done
```

- [ ] **Step 2: Классифицировать**

Для каждого поля отметить: (a) пишется ли (провижн/инсталл/схема Create/Update), (b) читается ли
(ответ API/рендер UI). «Мёртвое» = ноль осмысленных чтений И ноль записей вне определения модели.

- [ ] **Step 3: Действие по результату**

- Если поле используется (ожидаемо для всех шести) — **не трогать**, зафиксировать в блоке «Итог»
  этого плана строку «FastPanel-поля: все используются, удалений нет».
- Если нашлось мёртвое поле — удалить его из `backend/app/models/server.py`,
  `backend/app/schemas/server.py` и добавить `op.drop_column("servers", "<field>")` в новую миграцию
  `014_drop_dead_fastpanel_fields.py` (down_revision `013_drop_ssl_email_pool`), затем прогнать
  `pytest -q` и `tsc --noEmit`.

- [ ] **Step 4: Коммит (только если были правки)**

```bash
git add -A
git commit -m "chore(server): drop unused fastpanel metadata field(s)"
```

Если правок нет — коммита нет; вывод фиксируется в «Итог».

---

## Task 11: Документировать компромисс TOTP + финальный ZK-sweep (приёмочный gate)

Закрываем два пункта: (1) ADR по плейнтекст-TOTP; (2) финальная проверка, что ни один секрет не
покидает клиент незашифрованным и каждая мутация логируется.

**Files:**
- Create: `docs/security/TOTP_STORAGE.md`
- Modify: `backend/app/auth/models.py:21` (комментарий)

- [ ] **Step 1: Написать ADR по TOTP**

Создать `docs/security/TOTP_STORAGE.md`:

```markdown
# ADR: хранение TOTP-секрета в плейнтексте (временный компромисс)

**Дата:** 2026-08-02  **Статус:** принято (фаза «для себя»).

## Контекст
`users.totp_secret` (`backend/app/auth/models.py`) хранится открытым (`String(64)`). Это seed
серверной 2FA, а не пользовательский ZK-секрет (SSH-пароли / API-токены шифруются на клиенте и
лежат как blob'ы). При утечке БД seed ослабляет 2FA, но сам по себе входа не даёт: требуется ещё
`auth_key`, выводимый из пароля на клиенте (Argon2id) и на сервере не хранимый в открытом виде.

## Решение
В текущей фазе (один пользователь, self-host) оставляем плейнтекст и документируем компромисс.
Схему БД не меняем.

## Триггер пересмотра (перед продуктовой фазой / мультиарендностью)
Зашифровать `totp_secret` app-level симметричным ключом (KEK из env / KMS), с миграцией
существующих значений и обработкой ротации ключа. Альтернатива — вынести 2FA в отдельный провайдер.

## Проверка
`grep -rn "totp_secret" backend/app` — единственное место хранения; в audit_log seed не попадает.
```

- [ ] **Step 2: Комментарий-компромисс в модели**

В `backend/app/auth/models.py` над строкой 21 (`totp_secret`) добавить:

```python
    # NOTE: плейнтекст — осознанный временный компромисс (фаза «для себя»), см.
    # docs/security/TOTP_STORAGE.md. Зашифровать перед продуктовой фазой.
```

- [ ] **Step 3: ZK-sweep — плейнтекст-секреты на сервере**

```bash
# Открытые секретные поля на серверных моделях (ожидаем: только totp_secret, задокументирован).
grep -rniE "password|secret|token|api_key" backend/app/models backend/app/schemas \
  | grep -viE "blob_id|_hash|token_hash|blob_kind"
```
Ожидание: секреты присутствуют только как `*_blob_id` (ссылки на зашифрованные blob'ы) или `*_hash`;
единственный открытый — `totp_secret` (покрыт ADR). Любая иная находка — дефект, завести отдельную
задачу.

- [ ] **Step 4: ZK-sweep — аудит покрывает все мутации**

```bash
# Роуты-мутации без вызова audit_service — кандидаты на пропуск.
grep -rnE "@router\.(post|put|patch|delete)" backend/app | sort
grep -rn "audit_service.log" backend/app | sort
```
Сверить списки: каждая изменяющая состояние ручка (кроме auth-flow, где аудит уже есть) должна иметь
соответствующий `audit_service.log`. Исключения (например Celery-триггеры) — осознанно отметить.

- [ ] **Step 5: Финальный полный прогон**

Run: `cd backend && python3.12 -m pytest -q`
Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: всё зелёное.

- [ ] **Step 6: Коммит**

```bash
git add docs/security/TOTP_STORAGE.md backend/app/auth/models.py
git commit -m "docs(security): ADR for plaintext TOTP tradeoff + zk-sweep gate"
```

---

## Task 12: Audit для массовых (bulk) маршрутов — [x] выполнено

Найдено ZK-sweep'ом: **каждый единичный CRUD-маршрут пишет audit, ни один его bulk-вариант — нет.**
Перенос одного домена оставлял запись, переезд 500 доменов — ни одной.

**Истинный список пробелов (сверено `grep @router.(post|put|patch|delete)` против
`grep audit_service.log`): 6 маршрутов, не 7.**

| Маршрут | Действие |
|---|---|
| `POST /domains/bulk` | `domain.bulk_create` (`mode: "text"`) |
| `POST /domains/bulk-structured` | `domain.bulk_create` (`mode: "structured"`) |
| `POST /domains/bulk-assign-server` | `domain.bulk_assign_server` |
| `POST /domains/bulk-assign-cloudflare` | `domain.bulk_assign_cloudflare` |
| `POST /domains/bulk-import` | `domain.bulk_import` |
| `POST /servers/bulk-import` | `server.bulk_import` |

6 маршрутов → 5 действий: два маршрута создания доменов — одна и та же операция с разной формой
входа, их различает `metadata.mode`, а не отдельное действие.

**Дисциплина метаданных** (в `backend/app/audit/` нет ни одного слоя редакции — metadata пишется
в JSONB как есть):

- только счётчики и цель, **никаких перечней сущностей**: 500-элементный массив id в JSONB
  бесполезен;
- у bulk-assign цель — сервер / CF-аккаунт (`target_type`/`target_id`) плюс
  `domains_requested`/`domains_updated`;
- у импортов — `filename` (обрезано до 255), `created`/`skipped`/`errors` (**число** ошибок, не
  список: список построчно повторяет содержимое файла);
- **не пишется** `errors_csv_url` — в нём токен неаутентифицированной выдачи CSV;
- **не пишется** ничего из колонки `ssh_password` CSV импорта серверов и ни одной ячейки строки.

**Files:**
- Modify: `backend/app/audit/service.py` (`SAFE_ACTIONS`: 34 → 39)
- Modify: `backend/app/api/routes/domains.py`, `backend/app/api/routes/servers.py`
- Modify: `backend/tests/test_audit_actions.py` (TDD: сначала падающий тест на allow-list)
- Create: `backend/tests/test_bulk_audit.py` (5 httpx ASGI интеграционных тестов)
- Modify: `frontend/src/pages/dashboardData.ts` (`ACTION_LABELS`), `dashboardData.test.ts` (34 → 39)

- [x] **Step 1:** падающий тест `test_bulk_actions_are_in_safe_actions`, затем 5 действий в
      `SAFE_ACTIONS`.
- [x] **Step 2:** `audit_service.log(...)` + `await db.commit()` в 6 маршрутах.
- [x] **Step 3:** `ACTION_LABELS` 1:1 с `SAFE_ACTIONS` (проверено скриптом-диффом, не глазами:
      39 = 39, симметрическая разность пуста).
- [x] **Step 4:** `pytest` 35 passed; `vitest` 53/9; `tsc` 51 ошибка (все pre-existing).

**Известные ограничения (зафиксировано, не чинится здесь):**

1. **Аудит и мутация — в разных транзакциях.** Все `domain_service.*` / `server_service.create`
   коммитят внутри себя, маршрут потом делает `log(...)` + `commit()` вторым коммитом. Это ровно та
   же неатомарность, что найдена в `settings.config_update`, и она уже была у *единичных* CRUD —
   новые вызовы ей следуют, а не вводят её. Общая починка — вынести `commit` из сервисов.
2. **`GET /{domains,servers}/bulk-import-errors/{token}` не требует аутентификации** — проверено
   запросом без сессии, оба отдают 200. Хранилище `_ERROR_EXPORTS` — глобальный dict процесса без
   привязки к пользователю и без TTL, и оба маршрута принимают токен друг друга. Это чтение, поэтому
   вне задачи аудита, но пробел доступа реален.

---

## Acceptance criteria (что значит «готово»)

- [x] Любая мутация пишет запись в `audit_log`: blob PUT/DELETE, settings config-update и
      notification-test, notifications mark-read/delete/check-renewals (проверено тестами +
      ручной чек check-renewals).
- [x] В metadata audit нет ключей с `password`/`token` (assert в тестах зелёный).
- [x] TOTP-компромисс задокументирован (`docs/security/TOTP_STORAGE.md`) и помечен в модели.
- [x] На сервере нет открытых плейнтекст-полей секретов, кроме задокументированного `totp_secret`
      (ZK-sweep grep чист).
- [x] `server.notes` удалён (модель, схемы, bulk-import, фронт, миграция применена).
- [x] Легаси SSL-email-pool удалён целиком; `pytest`/`tsc`/`vitest` зелёные; таблица дропнута.
- [x] CSP `connect-src` берётся из `WEB_CSP_CONNECT_SRC` (проверено рендером конфига вне localhost);
      nginx-переменные не сломаны.
- [x] Вкладка Encryption описывает Argon2id + libsodium secretbox (тест guard зелёный; нет упоминаний
      AES-256-GCM/ENCRYPTION_KEY/SHA-256). **Правка к формулировке критерия:** здесь стояло
      «XChaCha20-Poly1305», но `crypto_secretbox_easy` (dryoc в десктопе, libsodium-wrappers во
      фронте) — это XSalsa20-Poly1305. Текст вкладки написан по коду, а не по этому пункту.
- [x] FastPanel-поля: зафиксирован вывод верификации (используются / что удалено).

## Edge cases (продумать заранее)

- **Ноль данных / новый пользователь:** тест settings-audit берёт editable-ключ динамически; если
  конфигов нет — явный assert подскажет предусловие.
- **Идемпотентность миграций:** `012`/`013` линейны за `011`; downgrade у обеих восстанавливает
  структуру (для `ssl_email_pool` — полный `create_table`).
- **Celery без брокера (тесты):** `check_renewals` не покрываем интеграционным тестом — только ручной
  чек, чтобы не ловить флаки.
- **envsubst и nginx-переменные:** `NGINX_ENVSUBST_FILTER=WEB_CSP_CONNECT_SRC` не даёт затронуть
  `$host`/`$http_upgrade`/`$proxy_add_x_forwarded_for`/`$http_x_request_id`.
- **Zero-knowledge:** blob-ciphertext и plaintext-секреты в audit-metadata не пишутся (только
  `blob_kind`/`key`/счётчики); ZK-sweep — приёмочный gate.
- **Обратная совместимость sync:** удаление `ssl_email_pool` из `SCOPED_MODELS` уменьшает набор
  синхронизируемых таблиц; локальный кэш десктопа при следующем полном снапшоте просто не получит эту
  таблицу (в фазе ручного ввода некритично).

## Итог

**Реализован целиком: да** (Tasks 1–11), плюс четыре вещи сверх плана — три согласованы с
пользователем по ходу, одна оказалась критической.

Коммиты: `1d5000e` … `49338fb`, затем `26d0295`, `1d9df7f`, `00e0430`.

### Что сделано по плану

| Task | Коммит | Результат |
|---|---|---|
| 1 | `1d5000e` | `SAFE_ACTIONS` 27 → 34 |
| 2–4 | `fc3e3d1`, `edf069d`, `0d96199` | audit в blob PUT/DELETE, settings, notifications |
| 5 | `e47f80a`, `f545645` | ярлыки во фронте + интеграционные тесты |
| 6 | `f7d6da3` | `server.notes` удалён, миграция `012` |
| 7 | `dd86037`, `793f433` | CSP из `WEB_CSP_CONNECT_SRC` через envsubst |
| 8 | `75c6bda`, `600170a` | SSL-email-pool удалён целиком, миграция `013` |
| 9 | `9c8504f` | ADR `docs/security/TOTP_STORAGE.md` |
| 10 | — | FastPanel-поля: **все используются**, удалять нечего (см. ниже) |
| 11 | `1730f8c` | вкладка Encryption переписана по коду |

**Вывод Task 10 (обещал зафиксировать здесь).** Ни одно `fastpanel_*` не оказалось мёртвым:
`fastpanel_status/url/user/version/port/password_blob_id` читаются в Servers, Dashboard,
ServerDetail, deepLink и Activity. Важная деталь метода: десктоп читает строки локального
кэша по строковому ключу (`row.get("fastpanel_status")`), поэтому grep по идентификаторам
такие чтения **не находит** — искать нужно по строковым литералам. Удалено ничего.

### Сверх плана

1. **Критическая уязвимость** (нашёл ZK-sweep). `POST /auth/recovery/finish` не требовал
   никаких доказательств: знание чужого email давало право перезаписать `salt`,
   `auth_key_hash` и recovery-блоб. Это не кража доступа, а **необратимое уничтожение**:
   блобы остаются зашифрованными на старом мастер-ключе, и данные не восстановит уже никто,
   включая владельца. Существующий тест фиксировал это как ожидаемое поведение.
   Починка — отдельный план `2026-08-03-recovery-proof-of-phrase.md` (коммиты `26d0295`,
   `1d9df7f`, `00e0430`), вариант выбран пользователем: доказательство владения фразой.
2. `7bdd0bf` — **`system_config` уезжал в sync всем клиентам целиком**, включая
   `Webhook Secret` в плейнтексте: `sync/routes.py` сериализует колонки модели generically
   через `obj.__table__.columns`, поэтому любое открытое поле на таблице из `SCOPED_MODELS`
   автоматически оказывается у каждого клиента. Таблица убрана из `SCOPED_MODELS`,
   добавлен `ConfigOwnershipError` + `_is_writable_by`.
3. `8d564ce` — 7 массовых мутаций доменов/серверов писались без аудита; логируются счётчики,
   без секретов. `SAFE_ACTIONS` 34 → 39.
4. Правка формулировки в acceptance-критериях: шифр — XSalsa20-Poly1305 (libsodium
   `crypto_secretbox_easy`), а не XChaCha20-Poly1305. То же исправлено в `CLAUDE.md`.

### Проверено

backend 46 passed · cargo test 76 passed / 1 ignored · vitest 70 passed в 12 файлах ·
`tsc` 51 ошибка (ровно преэкзистующий долг) · alembic на `014_recovery_auth_key`.

### Оговорка о чекбоксах

Пошаговые `- [ ]` внутри задач по ходу исполнения не проставлялись — исполнители работали
по под-навыку и отчитывались коммитами. Источник правды по объёму — таблица коммитов выше и
acceptance-критерии, они выверены. Не проставляю их задним числом, чтобы не выдавать
реконструкцию за факт.

### Перенесено в следующий спринт (найдено, но не чинилось)

1. **Нет серверной защиты audit-метаданных от секретов.** Редактирующего guard'а не
   существует; от плейнтекста защищают только тесты, и лишь на 3 из ~18 мест вызова.
   Новый роут с `metadata={"password": ...}` пройдёт молча.
2. **`GET /{domains,servers}/bulk-import-errors/{token}`** — без аутентификации, из
   process-global dict, без привязки к пользователю, без проверки владения и без TTL;
   токены к тому же взаимно подходят к обоим эндпоинтам.
3. **Audit-строки коммитятся отдельной транзакцией от самой мутации** — при сбое между ними
   расходятся факт и запись о нём.
4. Пять auth-роутов без аудита.
5. Пробелы достижимости UI из Спринта 1: часть Tauri-команд не имеет точки входа в интерфейсе.
6. Ручной сквозной прогон recovery (фаза 5 плана recovery) — автотесты закрыты, живьём не гоняли.
