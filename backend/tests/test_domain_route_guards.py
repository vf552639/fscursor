"""Гарды `POST /api/domains` и массовых привязок: отказ вместо 500 и вместо тишины.

Одиночный вход мастера full-setup — это существующий `POST /api/domains`
(мастер создаёт домен, а потом идёт с его `id` в `/domains/full-setup`).
Пройти через него было нельзя на самом обычном сценарии: домен, который уже
заведён, отвечал 500 из `IntegrityError`, а мусорное имя («не домен вовсе»)
заводилось со статусом 201 и доезжало до десктопа как имя будущей зоны
Cloudflare.

`domains.domain_name` уникален ГЛОБАЛЬНО, поэтому «уже заведён» бывает и про
чужую строку — этот случай проверяется отдельно, вместе с тем, что ответ не
рассказывает про владельца.

Здесь же — владение целью массовых привязок: `bulk-assign-server` и
`bulk-assign-cloudflare` принимали чужой id молча.

База тестов общая с dev-окружением, поэтому пользователи теста убираются в
teardown, а домены/серверы уезжают за ними по FK CASCADE.
"""

import asyncio
import base64
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.domain import Domain

_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
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


async def _register_and_login(c: AsyncClient, prefix: str, key: bytes = b"\x01" * 32) -> str:
    email = f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"
    _REGISTERED_EMAILS.append(email)
    r = await c.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(key),
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
    r = await c.post("/api/auth/login/finish", json={"email": email, "auth_key_b64": b64(key)})
    assert r.status_code == 200, r.text
    return email


def _name() -> str:
    return f"{uuid.uuid4().hex[:10]}.example.com"


async def _create_server(c: AsyncClient) -> int:
    r = await c.post(
        "/api/servers",
        json={
            "name": f"srv-{uuid.uuid4().hex[:6]}",
            "ip_address": f"203.0.113.{uuid.uuid4().int % 200 + 10}",
        },
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create_cf_account(c: AsyncClient) -> int:
    r = await c.post("/api/cloudflare/accounts", json={"name": f"cf-{uuid.uuid4().hex[:6]}"})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _rows_named(name: str) -> int:
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(select(func.count(Domain.id)).where(Domain.domain_name == name))
        ).scalar_one()


async def _links(domain_id: int) -> tuple:
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(
                select(Domain.server_id, Domain.cloudflare_account_id).where(
                    Domain.id == domain_id
                )
            )
        ).one()


@pytest.mark.asyncio
async def test_creating_my_own_domain_twice_is_409_not_500():
    """Повтор своего домена — конфликт с внятным телом, и строка не двоится.

    Позитивный контроль в конце обязателен: после отката неудачной вставки
    сессия должна оставаться рабочей. Без `rollback()` в сервисе следующий же
    запрос в том же соединении падал бы уже не по своей вине.
    """
    name = _name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "dup-own")
        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 201, r.text

        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == "domain already exists"
        assert await _rows_named(name) == 1

        r = await c.post("/api/domains", json={"domain_name": _name()})
        assert r.status_code == 201, f"после конфликта сессия сломана: {r.text}"


@pytest.mark.asyncio
async def test_domain_taken_by_another_user_is_409_that_names_no_owner():
    """Чужое имя — тоже 409, но текст не говорит ни владельца, ни id.

    Скрыть сам факт занятости отсюда нельзя: его делает наблюдаемым глобальный
    UNIQUE на `domain_name`. Прежний 500 сообщал ровно тот же бит, только
    вдобавок выглядел поломкой. Закрывается это уникальностью по паре
    (user_id, domain_name), то есть миграцией, — записано долгом.
    """
    name = _name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        owner_email = await _register_and_login(c, "dup-owner")
        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 201, r.text
        await c.post("/api/auth/logout")

        await _register_and_login(c, "dup-other", key=b"\x99" * 32)
        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert detail == "domain name is already taken"
        assert owner_email not in detail
        assert owner_email.split("@")[0] not in detail
        # Чужая строка не тронута, своей не появилось.
        assert await _rows_named(name) == 1
        assert (await c.get("/api/domains")).json() == []

        r = await c.post("/api/domains", json={"domain_name": _name()})
        assert r.status_code == 201, f"после конфликта сессия сломана: {r.text}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_name",
    [
        pytest.param("не домен вовсе", id="not-a-domain"),
        pytest.param("", id="empty"),
        pytest.param("example", id="no-tld"),
        pytest.param("http://example.com", id="url-not-name"),
        # Форму такое имя проходит (метки по 3 символа), а в колонку
        # `String(255)` не влезает: без границы длины это был бы 500 из
        # драйвера, а не 422.
        pytest.param("aaa." * 70 + "com", id="longer-than-the-column"),
    ],
)
async def test_a_name_that_is_not_a_domain_is_422_and_nothing_is_created(bad_name: str):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "bad-name")
        r = await c.post("/api/domains", json={"domain_name": bad_name})
        assert r.status_code == 422, r.text
        assert [e["loc"] for e in r.json()["detail"]] == [["body", "domain_name"]], r.text
        assert (await c.get("/api/domains")).json() == []


@pytest.mark.asyncio
async def test_the_name_is_normalized_before_it_is_checked_and_stored():
    """Нормализация идёт до проверки формы, иначе `Example.COM.` был бы 422."""
    core = _name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "norm")
        r = await c.post("/api/domains", json={"domain_name": f"  {core.upper()}.  "})
        assert r.status_code == 201, r.text
        assert r.json()["domain_name"] == core
        assert await _rows_named(core) == 1


@pytest.mark.asyncio
async def test_the_single_entrance_of_the_wizard_goes_through():
    """Оба входа full-setup — один поток: создать домен, затем связать по `id`.

    Ровно та последовательность, которую делает мастер «Add Domain».
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "wizard")
        server_id = await _create_server(c)
        cf_id = await _create_cf_account(c)

        r = await c.post("/api/domains", json={"domain_name": _name()})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": [domain_id],
                "server_id": server_id,
                "cloudflare_account_id": cf_id,
            },
        )
        assert r.status_code == 200, r.text
        assert [d["id"] for d in r.json()["domains"]] == [domain_id]
        assert await _links(domain_id) == (server_id, cf_id)


@pytest.mark.asyncio
async def test_bulk_create_skips_a_name_taken_by_another_user():
    """Чужое имя в пачке — `skipped`, а не падение всей пачки.

    Предпроверка занятых имён была сужена по `user_id`, а UNIQUE глобальный:
    чужое имя пролетало мимо неё в `IntegrityError` на общем коммите — и
    терялись ВСЕ строки пачки, а клиент получал 500.
    """
    taken = _name()
    fresh = _name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "bulk-owner")
        assert (await c.post("/api/domains", json={"domain_name": taken})).status_code == 201
        await c.post("/api/auth/logout")

        await _register_and_login(c, "bulk-other", key=b"\x99" * 32)
        r = await c.post("/api/domains/bulk", json={"domains_text": f"{taken}\n{fresh}"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert [d["domain_name"] for d in body["created"]] == [fresh]
        assert body["skipped"] == [taken]
        assert await _rows_named(taken) == 1


@pytest.mark.asyncio
async def test_bulk_assign_refuses_a_foreign_server_and_a_foreign_cf_account():
    """Свои домены нельзя привязать к чужой сущности по угаданному id.

    404 подпёрт позитивным контролем: те же вызовы со своими сервером и
    аккаунтом обязаны дать 200 и связать домен, иначе отказ ничего не доказывает.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "assign-owner", key=b"\x99" * 32)
        foreign_server = await _create_server(c)
        foreign_cf = await _create_cf_account(c)
        await c.post("/api/auth/logout")

        await _register_and_login(c, "assign-other")
        my_server = await _create_server(c)
        my_cf = await _create_cf_account(c)
        r = await c.post("/api/domains", json={"domain_name": _name()})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]

        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [domain_id], "server_id": foreign_server},
        )
        assert r.status_code == 404, r.text
        r = await c.post(
            "/api/domains/bulk-assign-cloudflare",
            json={"domain_ids": [domain_id], "cloudflare_account_id": foreign_cf},
        )
        assert r.status_code == 404, r.text
        assert await _links(domain_id) == (None, None)

        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [domain_id], "server_id": my_server},
        )
        assert r.status_code == 200, r.text
        r = await c.post(
            "/api/domains/bulk-assign-cloudflare",
            json={"domain_ids": [domain_id], "cloudflare_account_id": my_cf},
        )
        assert r.status_code == 200, r.text
        assert await _links(domain_id) == (my_server, my_cf)

        # `None` — легальное «отвязать», проверять там нечего.
        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [domain_id], "server_id": None},
        )
        assert r.status_code == 200, r.text
        assert (await _links(domain_id))[0] is None
