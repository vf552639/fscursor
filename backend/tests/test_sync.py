import asyncio
import base64
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app

# Пользователи, заведённые тестами этого файла через `_login` — регистрация
# живёт внутри неё, а не в теле каждого теста, поэтому уборка накрывает всех
# вызывающих без отдельного вызова на каждый тест.
_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
    """Убрать пользователей теста — сервер и sync-состояние уедут по FK CASCADE.

    Паттерн — из `test_server_provider.py`/`test_secret_write_path.py`: база
    тестов общая с dev-окружением, и без уборки в ней копятся `sync-prov-*`.
    """
    _REGISTERED_EMAILS.clear()
    yield
    emails = list(_REGISTERED_EMAILS)
    _REGISTERED_EMAILS.clear()
    if emails:
        asyncio.run(_purge_users(emails))


async def _purge_users(emails: list[str]) -> None:
    async with AsyncSessionLocal() as s:
        await s.execute(sa_delete(User).where(User.email.in_(emails)))
        await s.commit()


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _login(client: AsyncClient, email: str) -> None:
    from datetime import datetime, timezone

    # Регистрация здесь одна на оба теста файла — до фикса `test_sync_snapshot_includes_domain`
    # не чистил за собой и накопил в общей dev-БД 75 пользователей `sync-%` и 74 домена
    # (~12% всех доменов в базе). Уборка на уровне `_login`, а не в теле каждого теста,
    # закрывает утечку у всех вызывающих разом, включая будущих.
    _REGISTERED_EMAILS.append(email)
    await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
            "wrapped_vault_key_b64": b64(b"\x04" * 72),
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


@pytest.mark.asyncio
async def test_sync_snapshot_includes_domain():
    email = f"sync-{uuid.uuid4().hex[:8]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _login(c, email)
        r = await c.get("/api/sync/snapshot")
        assert r.status_code == 200
        assert r.json()["rows"] == []

        r = await c.post(
            "/api/domains",
            json={"domain_name": f"{uuid.uuid4().hex[:8]}.example.com"},
        )
        assert r.status_code == 201
        r = await c.get("/api/sync/snapshot")
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert any(row["table"] == "domains" for row in rows)


def _server_row(rows: list[dict], server_id: int) -> dict:
    """Найти строку `servers` данного сервера среди строк sync-ответа.

    Отдельная функция вместо голого `next(...)` в теле теста: без нужной
    строки `next()` над пустым генератором роняет тест `RuntimeError:
    coroutine raised StopIteration` — ни имени таблицы, ни искомого `id` в
    выводе pytest не видно. Здесь вместо этого — `assert` с текстом,
    который называет обе причины промаха (сервер не в ответе вовсе или
    `table` не совпал), и завершившийся диагностируемым падением, а не
    невнятным исключением.
    """
    matches = [row for row in rows if row["table"] == "servers" and row["id"] == str(server_id)]
    assert matches, f"строки сервера {server_id} нет среди строк sync-ответа: {rows}"
    return matches[0]


@pytest.mark.asyncio
async def test_sync_snapshot_and_changes_carry_server_provider_including_when_cleared_to_null():
    """`provider` доезжает и до `/sync/snapshot`, и до инкрементального `/sync/changes`.

    План `tagprovider.md` обещает, что новый столбец не требует правок ни
    `_to_row` (`app/sync/routes.py`), ни Rust: `fields` сериализует все колонки
    модели generic-ом. Проверка — по значению в JSON-снапшоте, а не по факту
    200, потому что именно значение и есть то, что десктоп положит в свой
    локальный кеш; тест, довольный одним статусом, зеленел бы и в мире, где
    `_to_row` явно перечисляет столбцы и `provider` в список забыли добавить.

    Оба эндпоинта нужны порознь: `/snapshot` отдаёт полный набор строк,
    `/changes` — только версии выше `since`, и у них разные фильтры в
    `app/sync/routes.py` (`select(model)` целиком против
    `model.sync_version > since`). Разошедшиеся реализации могли бы разойтись
    и в том, что именно они кладут в `fields` — поэтому оба провода проверены
    порознь, а не только один за компанию с другим.
    """
    email = f"sync-prov-{uuid.uuid4().hex[:8]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _login(c, email)

        # Версия синка ДО создания сервера — нужна как "since" для changes-пула.
        snapshot_resp = await c.get("/api/sync/snapshot")
        assert snapshot_resp.status_code == 200
        version_before_create = snapshot_resp.json()["version"]

        create_resp = await c.post(
            "/api/servers",
            json={
                "name": f"srv-sync-{uuid.uuid4().hex[:6]}",
                "ip_address": "203.0.113.60",
                "provider": "Hetzner Online",
            },
        )
        assert create_resp.status_code == 201, create_resp.text
        server_id = create_resp.json()["id"]

        snapshot_resp = await c.get("/api/sync/snapshot")
        assert snapshot_resp.status_code == 200
        server_row = _server_row(snapshot_resp.json()["rows"], server_id)
        assert server_row["fields"].get("provider") == "Hetzner Online", (
            "provider не доехал до полного sync-снапшота"
        )

        changes_resp = await c.get(f"/api/sync/changes?since={version_before_create}")
        assert changes_resp.status_code == 200
        changed_server_row = _server_row(changes_resp.json()["rows"], server_id)
        assert changed_server_row["fields"].get("provider") == "Hetzner Online", (
            "provider не доехал до инкрементального /sync/changes"
        )

        # NULL-провайдер — тоже значение, а не отсутствие ключа: десктопный
        # кеш обязан увидеть явный null и стереть старое значение, а не
        # промолчать, оставив прежнего провайдера в локальной копии.
        version_before_clear = changes_resp.json()["version"]
        update_resp = await c.put(f"/api/servers/{server_id}", json={"provider": None})
        assert update_resp.status_code == 200, update_resp.text

        cleared_changes_resp = await c.get(f"/api/sync/changes?since={version_before_clear}")
        assert cleared_changes_resp.status_code == 200
        cleared_server_row = _server_row(cleared_changes_resp.json()["rows"], server_id)
        # Явный `in`, а не `.get(...) is None`: второе не отличило бы «ключ
        # есть со значением None» от «ключа нет вовсе» — а различить их и есть
        # весь смысл этой проверки.
        assert "provider" in cleared_server_row["fields"], (
            "ключ provider пропал из снапшота вместо явного null"
        )
        assert cleared_server_row["fields"]["provider"] is None, (
            "очищенный провайдер не доехал до sync-снапшота как null"
        )
