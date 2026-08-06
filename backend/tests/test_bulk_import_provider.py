"""Провайдер в bulk-импорте серверов: шестая, опциональная колонка CSV/.xlsx.

Формат импорта — `name,ip,ssh_user,ssh_password,ssh_port[,provider]`. Провайдер
добавлен в конец умышленно (план `tagprovider.md`, фаза 2): файлы, залитые до
этой правки, обязаны продолжать импортироваться как раньше — без шестой
колонки строка не должна ни падать, ни превращать провайдер в мусор.

Как и в `test_server_provider.py`, утверждения — по колонке `servers.provider`,
а не по телу ответа: `ServerBulkImportResponse` вообще не возвращает
провайдера, так что эхо в ответе тут в принципе невозможно и провалилось бы
молча, если бы значение до `server_service.create` не доехало.
"""

import asyncio
import base64
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.server import Server
from app.services.bulk_import_service import _parse_server_row

_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
    """Убрать пользователей теста — серверы уедут за ними по FK CASCADE."""
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


async def _register_and_login(client: AsyncClient, email: str) -> None:
    _REGISTERED_EMAILS.append(email)
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
        },
    )
    assert r.status_code in (201, 409), r.text
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    r = await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(b"\x01" * 32)},
    )
    assert r.status_code == 200, r.text


async def _stored_provider(ip: str) -> object:
    """Значение колонки `servers.provider` для сервера с данным IP — прямо из БД."""
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(select(Server.provider).where(Server.ip_address == ip))
        ).scalar_one()


# ---------------------------------------------------------------------------
# Юнит-уровень: `_parse_server_row` — чистая функция, без БД и HTTP.
# ---------------------------------------------------------------------------


def test_parse_server_row_reads_sixth_column_as_provider():
    row = ["srv-1", "203.0.113.1", "root", "pass", "22", "Hetzner Online"]
    parsed = _parse_server_row(row, idx=2)
    assert parsed is not None
    assert parsed.provider == "Hetzner Online"


def test_parse_server_row_without_sixth_column_leaves_provider_none():
    """Пятиколоночная строка — старый формат, провайдера в ней нет и не будет."""
    row = ["srv-1", "203.0.113.1", "root", "pass", "22"]
    parsed = _parse_server_row(row, idx=2)
    assert parsed is not None
    assert parsed.provider is None


def test_parse_server_row_blank_provider_cell_is_none():
    """Пустая шестая ячейка — это отсутствие провайдера, а не пустая строка."""
    row = ["srv-1", "203.0.113.1", "root", "pass", "22", "   "]
    parsed = _parse_server_row(row, idx=2)
    assert parsed is not None
    assert parsed.provider is None


def test_parse_server_row_strips_provider_whitespace():
    row = ["srv-1", "203.0.113.1", "root", "pass", "22", "  Hetzner  "]
    parsed = _parse_server_row(row, idx=2)
    assert parsed is not None
    # Схема (`_checked_provider`) обрежет ещё раз, но парсер не обязан отдавать
    # значение с гарантированно лишними пробелами дальше по цепочке.
    assert parsed.provider == "Hetzner"


# ---------------------------------------------------------------------------
# Интеграционный уровень: HTTP-импорт → колонка `servers.provider`.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_csv_import_with_provider_column_stores_the_value():
    ip = f"203.0.113.{uuid.uuid4().int % 200 + 10}"
    name = f"srv-{uuid.uuid4().hex[:8]}"
    csv_body = (
        "name,ip,ssh_user,ssh_password,ssh_port,provider\n"
        f"{name},{ip},root,pw,22,Hetzner Online\n"
    ).encode()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"bulk-prov-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 1, body

        assert await _stored_provider(ip) == "Hetzner Online", (
            "провайдер из шестой колонки CSV не доехал до колонки БД"
        )


@pytest.mark.asyncio
async def test_csv_import_without_provider_column_still_works():
    """Обратная совместимость: пятиколоночный файл импортируется как раньше."""
    ip = f"203.0.113.{uuid.uuid4().int % 200 + 10}"
    name = f"srv-{uuid.uuid4().hex[:8]}"
    csv_body = (
        "name,ip,ssh_user,ssh_password,ssh_port\n"
        f"{name},{ip},root,pw,22\n"
    ).encode()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"bulk-noprov-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 1, body

        assert await _stored_provider(ip) is None, (
            "файл без колонки провайдера не должен ничего писать в неё"
        )


@pytest.mark.asyncio
async def test_csv_import_skips_row_with_invalid_provider_without_failing_the_batch():
    """Невалидный провайдер (управляющий символ) роняет строку, а не весь файл.

    `ServerCreate(...)` собирается из данных строки импорта; если бы это
    построение стояло вне `try/except`, `pydantic.ValidationError` по
    провайдеру пробила бы наружу и превратила один плохой ряд в 500 на весь
    импорт. Хорошая соседняя строка обязана всё равно создаться.
    """
    bad_ip = f"203.0.113.{uuid.uuid4().int % 200 + 10}"
    good_ip = f"203.0.113.{(uuid.uuid4().int % 200 + 10) + 1}"
    bad_name = f"srv-bad-{uuid.uuid4().hex[:8]}"
    good_name = f"srv-good-{uuid.uuid4().hex[:8]}"
    # Управляющий символ внутри поля — CSV допускает его в кавычках.
    csv_body = (
        "name,ip,ssh_user,ssh_password,ssh_port,provider\n"
        f'{bad_name},{bad_ip},root,pw,22,"Het\nzner"\n'
        f"{good_name},{good_ip},root,pw,22,Hetzner\n"
    ).encode()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"bulk-badprov-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 1, body
        assert body["skipped"] == 1, body
        assert body["errors"], "плохая строка обязана попасть в errors"

        assert await _stored_provider(good_ip) == "Hetzner"
        async with AsyncSessionLocal() as s:
            bad_created = (
                await s.execute(select(Server.id).where(Server.ip_address == bad_ip))
            ).scalar_one_or_none()
        assert bad_created is None, "строка с невалидным провайдером не должна была создать сервер"
