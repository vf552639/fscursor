"""Гарды `POST /api/domains` и `PUT /api/domains/{id}`: отказ вместо 500 и тишины.

Одиночный вход мастера full-setup — это существующий `POST /api/domains`
(мастер создаёт домен, а потом идёт с его `id` в `/domains/full-setup`).
Пройти через него было нельзя на самом обычном сценарии: домен, который уже
заведён, отвечал 500 из `IntegrityError`, а мусорное имя («не домен вовсе»)
заводилось со статусом 201 и доезжало до десктопа как имя будущей зоны
Cloudflare.

`domains.domain_name` уникален ГЛОБАЛЬНО, поэтому «уже заведён» бывает и про
чужую строку — этот случай проверяется отдельно, вместе с тем, что ответ не
рассказывает про владельца.

Здесь же — владение связками: чужой (или несуществующий) `server_id` /
`cloudflare_account_id` / `registrar_id` не должен ни записываться, ни
доезжать до драйвера нарушением FK.

Заготовка (регистрация, уборка, заведение сервера/аккаунтов) — общая, в
`conftest.py`.
"""

import pytest
from conftest import (
    create_cf_account,
    create_registrar,
    create_server,
    domain_name,
    register_and_login,
)
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.domain import Domain

pytestmark = pytest.mark.usefixtures("purge_test_users")


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
    name = domain_name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "dup-own")
        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 201, r.text

        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == "domain already exists"
        assert await _rows_named(name) == 1

        r = await c.post("/api/domains", json={"domain_name": domain_name()})
        assert r.status_code == 201, f"после конфликта сессия сломана: {r.text}"


@pytest.mark.asyncio
async def test_domain_taken_by_another_user_is_409_that_names_no_owner():
    """Чужое имя — тоже 409, но текст не говорит ни владельца, ни id.

    Скрыть сам факт занятости отсюда нельзя: его делает наблюдаемым глобальный
    UNIQUE на `domain_name`. Прежний 500 сообщал ровно тот же бит, только
    вдобавок выглядел поломкой. Закрывается это уникальностью по паре
    (user_id, domain_name), то есть миграцией, — записано долгом.
    """
    name = domain_name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        owner_email = await register_and_login(c, "dup-owner")
        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 201, r.text
        await c.post("/api/auth/logout")

        await register_and_login(c, "dup-other", key=b"\x99" * 32)
        r = await c.post("/api/domains", json={"domain_name": name})
        assert r.status_code == 409, r.text
        detail = r.json()["detail"]
        assert detail == "domain name is already taken"
        assert owner_email not in detail
        assert owner_email.split("@")[0] not in detail
        # Чужая строка не тронута, своей не появилось.
        assert await _rows_named(name) == 1
        assert (await c.get("/api/domains")).json() == []

        r = await c.post("/api/domains", json={"domain_name": domain_name()})
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
        await register_and_login(c, "bad-name")
        r = await c.post("/api/domains", json={"domain_name": bad_name})
        assert r.status_code == 422, r.text
        assert [e["loc"] for e in r.json()["detail"]] == [["body", "domain_name"]], r.text
        assert (await c.get("/api/domains")).json() == []


@pytest.mark.asyncio
async def test_the_name_is_normalized_before_it_is_checked_and_stored():
    """Нормализация идёт до проверки формы, иначе `Example.COM.` был бы 422."""
    core = domain_name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "norm")
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
        await register_and_login(c, "wizard")
        server_id = await create_server(c)
        cf_id = await create_cf_account(c)

        r = await c.post("/api/domains", json={"domain_name": domain_name()})
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
    taken = domain_name()
    fresh = domain_name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "bulk-owner")
        assert (await c.post("/api/domains", json={"domain_name": taken})).status_code == 201
        await c.post("/api/auth/logout")

        await register_and_login(c, "bulk-other", key=b"\x99" * 32)
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
        await register_and_login(c, "assign-owner", key=b"\x99" * 32)
        foreign_server = await create_server(c)
        foreign_cf = await create_cf_account(c)
        await c.post("/api/auth/logout")

        await register_and_login(c, "assign-other")
        my_server = await create_server(c)
        my_cf = await create_cf_account(c)
        r = await c.post("/api/domains", json={"domain_name": domain_name()})
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


@pytest.mark.asyncio
async def test_creating_a_domain_refuses_a_link_that_is_not_mine():
    """Чужая связка — 404, и несуществующая тоже: не 500 из нарушения FK.

    До проверки владения `POST /domains {"registrar_id": <нет такого>}` доезжал
    до драйвера и возвращался нарушением FK, то есть 500 на обычном вводе из
    мастера. А чужой существующий id принимался молча — 201 и строка, ссылающаяся
    на чужой сервер.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "link-owner", key=b"\x99" * 32)
        foreign_server = await create_server(c)
        foreign_registrar = await create_registrar(c)
        await c.post("/api/auth/logout")

        await register_and_login(c, "link-other")
        my_server = await create_server(c)
        my_registrar = await create_registrar(c)

        for body in (
            {"server_id": foreign_server},
            {"registrar_id": foreign_registrar},
            {"registrar_id": 2_000_000_000},
            {"cloudflare_account_id": 2_000_000_000},
        ):
            r = await c.post("/api/domains", json={"domain_name": domain_name(), **body})
            assert r.status_code == 404, f"{body}: {r.text}"
        assert (await c.get("/api/domains")).json() == []

        r = await c.post(
            "/api/domains",
            json={
                "domain_name": domain_name(),
                "server_id": my_server,
                "registrar_id": my_registrar,
            },
        )
        assert r.status_code == 201, (
            f"тот же POST не работает и со своими связками — 404 выше ничего "
            f"не доказывает: {r.text}"
        )


@pytest.mark.asyncio
async def test_updating_a_domain_holds_the_same_two_rules():
    """`PUT` — тот же путь записи имени и связок, и отказы у него те же.

    Переименование в занятое имя отвечало 500 из `IntegrityError`, мусорное имя
    проходило со статусом 200, чужая связка записывалась молча.
    """
    taken = domain_name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "put-owner", key=b"\x99" * 32)
        assert (await c.post("/api/domains", json={"domain_name": taken})).status_code == 201
        foreign_server = await create_server(c)
        await c.post("/api/auth/logout")

        await register_and_login(c, "put-other")
        mine = domain_name()
        r = await c.post("/api/domains", json={"domain_name": mine})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        second = domain_name()
        r = await c.post("/api/domains", json={"domain_name": second})
        assert r.status_code == 201, r.text

        # Переименование в чужое имя и в своё же второе — оба конфликт, но
        # текстом различаются ровно так же, как на заведении.
        r = await c.put(f"/api/domains/{domain_id}", json={"domain_name": taken})
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == "domain name is already taken"
        r = await c.put(f"/api/domains/{domain_id}", json={"domain_name": second})
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == "domain already exists"

        r = await c.put(f"/api/domains/{domain_id}", json={"domain_name": "не домен вовсе"})
        assert r.status_code == 422, r.text
        assert [e["loc"] for e in r.json()["detail"]] == [["body", "domain_name"]], r.text

        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": foreign_server})
        assert r.status_code == 404, r.text
        assert (await _links(domain_id))[0] is None

        # Своё же текущее имя — не конфликт, а no-op: 409 на нём был бы дефектом.
        r = await c.put(f"/api/domains/{domain_id}", json={"domain_name": mine.upper()})
        assert r.status_code == 200, r.text
        assert r.json()["domain_name"] == mine


@pytest.mark.asyncio
async def test_bulk_create_skips_a_name_too_long_for_the_column():
    """Слишком длинное имя — `skipped`, а не потеря всей пачки.

    Форму такое имя проходит (`DOMAIN_REGEX` не ограничивает число меток), в
    `String(255)` не влезает. Пока длину проверял только одиночный путь, годные
    строки пачки уже стояли в `db.add`, и общий коммит падал `DataError` — 500 и
    ни одного заведённого домена.
    """
    too_long = "aaa." * 70 + "com"
    good = domain_name()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "bulk-long")
        r = await c.post("/api/domains/bulk", json={"domains_text": f"{too_long}\n{good}"})
        assert r.status_code == 201, r.text
        body = r.json()
        assert [d["domain_name"] for d in body["created"]] == [good]
        assert body["skipped"] == [too_long]
