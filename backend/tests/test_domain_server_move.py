"""Переезд домена на другой сервер обязан забыть снимок со старой машины.

Смена `server_id` — это запись метаданных, а НЕ перенос сайта. Снимок
`fp_facts` при этом остаётся снятым со старой машины, и оставленный на месте он
показывает вкладке Server FTP-логин прежнего сервера рядом с IP нового —
реквизиты, которые выглядят рабочими и не работают ни там, ни там. Поэтому
любой писатель `server_id` обнуляет всю четвёрку `fp_facts`, `fp_facts_at`,
`fp_check_error`, `fp_checked_at`.

Писателей три (`PUT /domains/{id}`, `bulk-assign-server`, `full-setup`), и
правило у них общее — одна функция `_forget_facts_of_previous_server`: три
экрана про сервер в этом проекте уже разъезжались, когда правило жило в
вызывающем. Отсюда и форма тестов — не «сервис обнулил», а «каждый из трёх
входов обнулил».

Обратная половина правила не менее важна: тот же сервер (и `PUT`, вовсе не
упоминающий `server_id`) снимок НЕ трогает. Иначе любая правка карточки
стирала бы последнее известное состояние домена и подменяла бы знание
прочерком — то самое, что запрещает принцип №6 («не рисуй незнание
здоровьем», только наоборот).

Заготовка (регистрация, уборка, заведение сервера) — общая, в `conftest.py`.
"""

import pytest
from conftest import (
    create_cf_account,
    create_server,
    domain_name,
    register_and_login,
)
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.domain import Domain

pytestmark = pytest.mark.usefixtures("purge_test_users")

# Снимок формой повторяет то, что кладёт десктоп: важны здесь не значения, а
# то, что в нём есть реквизиты старой машины (`ftp_accounts`) — ради них
# правило и заведено.
FACTS = {
    "site": {"path": "/var/www/example", "user": "example_usr"},
    "ftp_accounts": [{"login": "example_usr", "home": "/var/www/example"}],
    "php_version": "8.2",
}

FACT_COLUMNS = ("fp_facts", "fp_facts_at", "fp_check_error", "fp_checked_at")

EMPTY_SNAPSHOT = dict.fromkeys(FACT_COLUMNS)


async def _facts(domain_id: int) -> dict:
    """Колонки снимка — прямо из БД, мимо схемы ответа."""
    async with AsyncSessionLocal() as s:
        domain = (
            await s.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one()
        return {name: getattr(domain, name) for name in FACT_COLUMNS}


async def _sync_version(domain_id: int) -> int:
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(select(Domain.sync_version).where(Domain.id == domain_id))
        ).scalar_one()


async def _domain_with_snapshot(c: AsyncClient, server_id: int) -> int:
    """Домен на сервере `server_id`, у которого уже есть снимок.

    Снимок ставится тем же путём, что и в жизни, — `POST /domains/{id}/facts`:
    писать колонки в обход роута значило бы проверять правило на состоянии,
    которого продукт не производит.
    """
    r = await c.post(
        "/api/domains", json={"domain_name": domain_name(), "server_id": server_id}
    )
    assert r.status_code == 201, r.text
    domain_id = r.json()["id"]
    r = await c.post(f"/api/domains/{domain_id}/facts", json={"facts": FACTS})
    assert r.status_code == 200, r.text
    assert (await _facts(domain_id))["fp_facts"] == FACTS
    return domain_id


@pytest.mark.asyncio
async def test_put_to_another_server_forgets_the_snapshot():
    """`PUT` с другим сервером обнуляет всю четвёрку — и в БД, и в ответе.

    Ответ проверяется отдельно от БД: карточка перерисовывается по телу `PUT`,
    и снимок, оставшийся в нём, показал бы старые реквизиты до перезагрузки
    страницы, даже если в БД уже пусто.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-put")
        old_server = await create_server(c)
        new_server = await create_server(c)
        domain_id = await _domain_with_snapshot(c, old_server)

        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": new_server})
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == EMPTY_SNAPSHOT
        body = r.json()
        assert body["server_id"] == new_server
        assert all(body[col] is None for col in FACT_COLUMNS), body


@pytest.mark.asyncio
async def test_put_that_unbinds_the_server_forgets_the_snapshot_too():
    """Отвязка (`server_id: null`) — тот же переезд: сервера больше нет.

    Отдельным случаем, а не частью предыдущего: сравнение «отличается ли» здесь
    идёт с `None`, и реализация, написанная через `if patch.get("server_id")`,
    прошла бы тест выше и провалила бы этот.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-unbind")
        server_id = await create_server(c)
        domain_id = await _domain_with_snapshot(c, server_id)

        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": None})
        assert r.status_code == 200, r.text
        assert r.json()["server_id"] is None
        assert await _facts(domain_id) == EMPTY_SNAPSHOT


@pytest.mark.asyncio
async def test_put_with_the_same_server_or_without_it_keeps_the_snapshot():
    """Тот же сервер — не переезд; `PUT` без `server_id` — тем более.

    Второй случай ловит самую вероятную ошибку реализации: «поле не прислали»
    (`exclude_unset`) прочитанное как `server_id = None` превратило бы любую
    правку карточки в отвязку и стёрло бы снимок.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-same")
        server_id = await create_server(c)
        domain_id = await _domain_with_snapshot(c, server_id)
        before = await _facts(domain_id)

        r = await c.put(f"/api/domains/{domain_id}", json={"server_id": server_id})
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == before, "тот же сервер стёр снимок"

        r = await c.put(f"/api/domains/{domain_id}", json={"site_user": "example_usr"})
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == before, "правка без server_id стёрла снимок"


@pytest.mark.asyncio
async def test_bulk_assign_server_forgets_only_of_those_who_moved():
    """Массовая привязка обнуляет снимок ровно у переехавших.

    Сброс сужен по `IS DISTINCT FROM`, `_set_links` — нет, и это намеренно:
    счётчик `updated` продолжает означать «сколько строк тронули». Домен, уже
    стоявший на целевом сервере, в счётчик входит, а снимок сохраняет.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-bulk")
        old_server = await create_server(c)
        target = await create_server(c)
        moving = await _domain_with_snapshot(c, old_server)
        staying = await _domain_with_snapshot(c, target)
        staying_before = await _facts(staying)
        moving_version = await _sync_version(moving)

        r = await c.post(
            "/api/domains/bulk-assign-server",
            json={"domain_ids": [moving, staying], "server_id": target},
        )
        assert r.status_code == 200, r.text
        assert r.json()["updated"] == 2

        assert await _facts(moving) == EMPTY_SNAPSHOT
        assert await _facts(staying) == staying_before, "снимок стёрт у никуда не ехавшего"
        # Своего `bump_version` у сброса нет — версию обнулённым строкам ставит
        # идущий следом `_set_links`. Если это когда-нибудь разъедется, десктоп
        # и read-only веб останутся со снимком, которого в БД уже нет.
        assert await _sync_version(moving) > moving_version


@pytest.mark.asyncio
async def test_full_setup_forgets_the_snapshot_of_a_moved_domain():
    """Третий писатель `server_id` — full-setup, и правило у него то же.

    Повтор с тем же сервером здесь заодно проверяет, что сброс не разрушил
    идемпотентность: заново обнулять нечего, снимок (уже пустой) не двигается.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await register_and_login(c, "move-fs")
        old_server = await create_server(c)
        target = await create_server(c)
        cf_id = await create_cf_account(c)
        domain_id = await _domain_with_snapshot(c, old_server)

        body = {
            "domain_ids": [domain_id],
            "server_id": target,
            "cloudflare_account_id": cf_id,
        }
        r = await c.post("/api/domains/full-setup", json=body)
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == EMPTY_SNAPSHOT
        version_after = await _sync_version(domain_id)

        r = await c.post("/api/domains/full-setup", json=body)
        assert r.status_code == 200, r.text
        assert await _facts(domain_id) == EMPTY_SNAPSHOT
        assert await _sync_version(domain_id) == version_after, "повтор тронул строку"
