"""Провайдер в bulk-импорте серверов: шестая, опциональная колонка CSV/.xlsx.

Формат импорта — `name,ip,ssh_user,ssh_password,ssh_port[,provider]`. Провайдер
добавлен в конец умышленно (план `tagprovider.md`, фаза 2): файлы, залитые до
этой правки, обязаны продолжать импортироваться как раньше — без шестой
колонки строка не должна ни падать, ни превращать провайдер в мусор.

Индекс 5 — не новый слот. До коммита `f7d6da3` («drop plaintext server.notes»)
`_parse_server_row` читал его как `notes` (`Text`, без ограничения длины и без
проверки символов); тот коммит убрал чтение из кода, но не тронул
`docs/ARCHITECTURE.md` / `docs/CURRENT_STATUS.md`, где формат ещё недавно был
описан как `...,ssh_port,notes`. Эта правка переиспользует тот же индекс под
`provider` (`String(64)` + `_checked_provider`; радиус поражения — ноль:
`f7d6da3` фиксирует «verified 0 non-null rows» на момент дропа `notes`),
документация поправлена отдельно. `test_notes_era_value_over_provider_length_
limit_now_skips_the_row` ниже фиксирует принятый регресс: notes-эровский файл
с заметкой длиннее лимита провайдера, который раньше исправно импортировался
бы, сегодня скипает строку.

Как и в `test_server_provider.py`, утверждения — по колонке `servers.provider`,
а не по телу ответа: `ServerBulkImportResponse` вообще не возвращает
провайдера, так что эхо в ответе тут в принципе невозможно и провалилось бы
молча, если бы значение до `server_service.create` не доехало.
"""

import asyncio
import base64
import uuid
from datetime import datetime, timezone
from typing import Optional

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import select, update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.core.validators import PROVIDER_MAX_LEN
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


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _register_and_login(client: AsyncClient, email: str) -> uuid.UUID:
    """Завести и залогинить пользователя; вернуть его `id`.

    БД тестов общая: IP из диапазона `203.0.113.x` встречается в нескольких
    файлах и, при коллизии рандома, внутри одного. `id` пользователя —
    единственный надёжный якорь, чтобы `_stored_provider` не поймал строку
    соседа с тем же IP.
    """
    _REGISTERED_EMAILS.append(email)
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": _b64(b"\x00" * 16),
            "auth_key_b64": _b64(b"\x01" * 32),
            "recovery_blob_b64": _b64(b"\x02" * 96),
            "recovery_auth_key_b64": _b64(b"\x03" * 32),
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
        user_id = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
    r = await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": _b64(b"\x01" * 32)},
    )
    assert r.status_code == 200, r.text
    return user_id


async def _stored_provider(ip: str, user_id: uuid.UUID) -> Optional[str]:
    """Значение колонки `servers.provider` для сервера с данным IP у ЭТОГО пользователя.

    Без фильтра по `user_id` `scalar_one()` при коллизии IP с соседним тестом
    (общая БД, фиксированные диапазоны в `test_server_provider.py`,
    `test_secret_write_path.py`, `test_provision_writeback.py`) вернул бы
    `MultipleResultsFound` — отравленная строка от прерванного прогона ломала
    бы этот тест навсегда, а не один раз.
    """
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(
                select(Server.provider).where(
                    Server.ip_address == ip, Server.user_id == user_id
                )
            )
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
        user_id = await _register_and_login(c, f"bulk-prov-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 1, body

        assert await _stored_provider(ip, user_id) == "Hetzner Online", (
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
        user_id = await _register_and_login(c, f"bulk-noprov-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 1, body

        assert await _stored_provider(ip, user_id) is None, (
            "файл без колонки провайдера не должен ничего писать в неё"
        )


@pytest.mark.asyncio
async def test_notes_era_value_over_provider_length_limit_now_skips_the_row():
    """Принятый регресс, а не гипотеза: notes-эровский файл со старой семантикой
    шестой колонки сегодня ведёт себя иначе на длинных значениях.

    До `f7d6da3` шестая колонка была `notes` — `Text`, без ограничения длины и
    без проверки символов, поэтому любая заметка исправно импортировалась бы.
    Сегодня тот же индекс — `provider` (`String(64)` + `_checked_provider`), и
    заметка длиннее `PROVIDER_MAX_LEN`, которая раньше прошла бы насквозь,
    сегодня скипает всю строку через `ValidationError`. Короткое значение,
    напротив, молча садится в `provider` — это уже покрыто
    `test_csv_import_with_provider_column_stores_the_value`, здесь дублировать
    незачем.

    В отличие от простого «row[5] стал provider» (это и так доказывают
    `test_parse_server_row_reads_sixth_column_as_provider` и остальной
    юнит-блок), этот тест проверяет поведенческое следствие смены семантики —
    через реальный HTTP+БД путь, а не через равенство константы во входе и
    выходе одной чистой функции.
    """
    ip = f"203.0.113.{uuid.uuid4().int % 200 + 10}"
    name = f"srv-{uuid.uuid4().hex[:8]}"
    # Легальная в старом формате notes-заметка — сегодня превышает лимит
    # провайдера ровно на один символ, чтобы граница была недвусмысленной.
    long_note = "x" * (PROVIDER_MAX_LEN + 1)
    csv_body = (
        "name,ip,ssh_user,ssh_password,ssh_port,provider\n"
        f"{name},{ip},root,pw,22,{long_note}\n"
    ).encode()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        user_id = await _register_and_login(c, f"bulk-notes-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 0, body
        assert body["skipped"] == 1, body

        async with AsyncSessionLocal() as s:
            created = (
                await s.execute(
                    select(Server.id).where(
                        Server.ip_address == ip, Server.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
        assert created is None, (
            "notes-эровская длинная заметка в шестой колонке раньше создавала сервер — "
            "сегодня обязана скипать строку, а не пройти молча"
        )


@pytest.mark.asyncio
async def test_csv_import_skips_row_with_invalid_provider_without_failing_the_batch():
    """Невалидный провайдер (управляющий символ) даёт `ValidationError` на
    построении `ServerCreate` — и эта ошибка скипает только свою строку, не
    весь файл.

    Проверяется именно этот случай (`ValidationError` от схемы), а не более
    широкое свойство «любая ошибка строки не роняет остальные»: у
    `server_service.create` нет `rollback` в обработке ошибок commit'а, и сбой
    уровня БД в одной строке мог бы испортить сессию для всех последующих —
    этот тест такой сценарий не проверяет и ничего о нём не утверждает.
    """
    # Один розыгрыш октета: два независимых uuid4 из пересекающихся диапазонов
    # иногда совпадали, и тогда «хорошая» строка с тем же IP, что и «плохая»,
    # создавалась под её адресом, а `bad_created is None` падал не по вине кода.
    octet = uuid.uuid4().int % 200 + 10
    bad_ip = f"203.0.113.{octet}"
    good_ip = f"203.0.113.{octet + 1}"
    bad_name = f"srv-bad-{uuid.uuid4().hex[:8]}"
    good_name = f"srv-good-{uuid.uuid4().hex[:8]}"
    # Управляющий символ внутри поля — CSV допускает его в кавычках.
    csv_body = (
        "name,ip,ssh_user,ssh_password,ssh_port,provider\n"
        f'{bad_name},{bad_ip},root,pw,22,"Het\nzner"\n'
        f"{good_name},{good_ip},root,pw,22,Hetzner\n"
    ).encode()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        user_id = await _register_and_login(c, f"bulk-badprov-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers/bulk-import",
            files={"file": ("servers.csv", csv_body, "text/csv")},
            data={"has_header": "true"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created"] == 1, body
        assert body["skipped"] == 1, body

        # Не просто «errors непуст» — это прошло бы и при отвале строки по
        # другой причине (например, случайной коллизии IP). Причина обязана
        # называть именно провайдера.
        bad_row_error = next((e for e in body["errors"] if e["server"] == bad_name), None)
        assert bad_row_error is not None, body["errors"]
        assert "provider" in bad_row_error["reason"].lower(), bad_row_error

        assert await _stored_provider(good_ip, user_id) == "Hetzner"
        async with AsyncSessionLocal() as s:
            # Тот же класс уязвимости, что и у `_stored_provider`: без фильтра
            # по `user_id` коллизия `bad_ip` с чужой строкой на общей БД дала
            # бы чужой `id` вместо `None` (или `MultipleResultsFound` при
            # коллизии с двумя строками) — и тест ошибочно зеленел бы либо
            # падал не по вине кода.
            bad_created = (
                await s.execute(
                    select(Server.id).where(
                        Server.ip_address == bad_ip, Server.user_id == user_id
                    )
                )
            ).scalar_one_or_none()
        assert bad_created is None, "строка с невалидным провайдером не должна была создать сервер"
