"""`POST /api/domains/full-setup` — половина full-setup, которой не нужен токен.

Бэкенд здесь только персистит связки (сервер + аккаунт Cloudflare +
регистратор) и отдаёт десктопу то, чем тот заведёт зону. Проверяется поэтому
не «ответ 200», а состояние в БД, идемпотентность повтора и то, что чужая
сущность в связку не попадает.

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
from sqlalchemy import select, update

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


async def _login(c: AsyncClient, email: str, key: bytes = b"\x01" * 32) -> None:
    r = await c.post("/api/auth/login/finish", json={"email": email, "auth_key_b64": b64(key)})
    assert r.status_code == 200, r.text


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


async def _create_registrar(c: AsyncClient) -> int:
    r = await c.post(
        "/api/registrars/accounts",
        json={"provider": "hostiq", "name": f"reg-{uuid.uuid4().hex[:6]}"},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create_domains(c: AsyncClient, count: int) -> list[int]:
    ids: list[int] = []
    for _ in range(count):
        r = await c.post(
            "/api/domains", json={"domain_name": f"{uuid.uuid4().hex[:10]}.example.com"}
        )
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
    return ids


async def _stored(domain_ids: list[int]) -> dict[int, dict]:
    """Связки и версия синхронизации — прямо из БД, мимо схемы ответа."""
    async with AsyncSessionLocal() as s:
        rows = (
            await s.execute(
                select(
                    Domain.id,
                    Domain.domain_name,
                    Domain.server_id,
                    Domain.cloudflare_account_id,
                    Domain.registrar_id,
                    Domain.sync_version,
                    Domain.cloudflare_zone_id,
                ).where(Domain.id.in_(domain_ids))
            )
        ).all()
    return {row.id: dict(row._mapping) for row in rows}


@pytest.mark.asyncio
async def test_links_are_persisted_and_response_feeds_the_desktop():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "fs-ok")
        server_id = await _create_server(c)
        cf_id = await _create_cf_account(c)
        reg_id = await _create_registrar(c)
        domain_ids = await _create_domains(c, 3)

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": domain_ids,
                "server_id": server_id,
                "cloudflare_account_id": cf_id,
                "registrar_id": reg_id,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["skipped_ids"] == []
        assert [d["id"] for d in body["domains"]] == sorted(domain_ids)

        stored = await _stored(domain_ids)
        # Имя в ответе — то самое, из которого десктоп заведёт зону.
        for item in body["domains"]:
            assert item["domain_name"] == stored[item["id"]]["domain_name"]
        for did in domain_ids:
            assert stored[did]["server_id"] == server_id
            assert stored[did]["cloudflare_account_id"] == cf_id
            assert stored[did]["registrar_id"] == reg_id
            # Зону заводит десктоп: бэкенд в Cloudflare не ходит и записать
            # сюда ничего не может.
            assert stored[did]["cloudflare_zone_id"] is None


@pytest.mark.asyncio
async def test_repeat_with_the_same_arguments_writes_nothing():
    """Идемпотентность — по факту записи, а не по совпадению ответов.

    Одинаковый ответ дал бы и повторный UPDATE тех же значений. Поэтому
    сторож — `sync_version`: он двигается на каждой записи в строку, и
    неизменность после повтора означает, что второй прогон в БД не полез.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "fs-idem")
        server_id = await _create_server(c)
        cf_id = await _create_cf_account(c)
        domain_ids = await _create_domains(c, 2)
        payload = {
            "domain_ids": domain_ids,
            "server_id": server_id,
            "cloudflare_account_id": cf_id,
        }

        first = await c.post("/api/domains/full-setup", json=payload)
        assert first.status_code == 200, first.text
        after_first = await _stored(domain_ids)

        second = await c.post("/api/domains/full-setup", json=payload)
        assert second.status_code == 200, second.text
        after_second = await _stored(domain_ids)

        assert second.json() == first.json()
        assert after_second == after_first, "повтор full-setup всё-таки записал в домены"


@pytest.mark.asyncio
async def test_missing_and_foreign_ids_are_report_rows_not_a_refusal():
    """Пропавший id не срывает связку остальным — он строка отчёта.

    Позитивный контроль внутри того же прогона: домен, который существует,
    обязан оказаться связанным. Иначе «остальное прошло» доказывал бы себя сам.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "fs-stranger", key=b"\x99" * 32)
        stranger_domain = (await _create_domains(c, 1))[0]
        await c.post("/api/auth/logout")

        await _register_and_login(c, "fs-partial")
        server_id = await _create_server(c)
        cf_id = await _create_cf_account(c)
        mine = await _create_domains(c, 2)
        deleted = mine.pop()
        assert (await c.delete(f"/api/domains/{deleted}")).status_code == 204

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": [*mine, deleted, stranger_domain, 2_000_000_000],
                "server_id": server_id,
                "cloudflare_account_id": cf_id,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert [d["id"] for d in body["domains"]] == sorted(mine)
        assert body["skipped_ids"] == [deleted, stranger_domain, 2_000_000_000]

        stored = await _stored([*mine, stranger_domain])
        assert stored[mine[0]]["server_id"] == server_id
        assert stored[stranger_domain]["server_id"] is None, "связали чужой домен"
        assert stored[stranger_domain]["cloudflare_account_id"] is None


@pytest.mark.asyncio
async def test_foreign_server_is_refused_and_nothing_is_written():
    """Чужой сервер в связке — 404, и ни один домен при этом не тронут.

    404 подпёрт позитивным контролем: тот же вызов со своим сервером обязан
    дать 200, иначе отказ ничего не доказывает — его вернул бы и отсутствующий
    маршрут.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "fs-owner", key=b"\x99" * 32)
        foreign_server = await _create_server(c)
        foreign_cf = await _create_cf_account(c)
        await c.post("/api/auth/logout")

        await _register_and_login(c, "fs-thief")
        my_server = await _create_server(c)
        my_cf = await _create_cf_account(c)
        domain_ids = await _create_domains(c, 1)

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": domain_ids,
                "server_id": foreign_server,
                "cloudflare_account_id": my_cf,
            },
        )
        assert r.status_code == 404, r.text
        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": domain_ids,
                "server_id": my_server,
                "cloudflare_account_id": foreign_cf,
            },
        )
        assert r.status_code == 404, r.text
        stored = await _stored(domain_ids)
        assert stored[domain_ids[0]]["server_id"] is None
        assert stored[domain_ids[0]]["cloudflare_account_id"] is None

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": domain_ids,
                "server_id": my_server,
                "cloudflare_account_id": my_cf,
            },
        )
        assert r.status_code == 200, (
            f"этот же вызов не работает и со своими сущностями — 404 выше "
            f"ничего не доказывает: {r.text}"
        )


@pytest.mark.asyncio
async def test_registrar_omitted_does_not_wipe_the_existing_one():
    """Регистратор не передан — «не трогать», а не «отвязать».

    У существующих доменов регистратор обычно проставлен импортом, и массовое
    действие без этого поля не должно его стирать.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "fs-reg")
        server_id = await _create_server(c)
        cf_id = await _create_cf_account(c)
        reg_id = await _create_registrar(c)
        domain_ids = await _create_domains(c, 1)
        r = await c.put(f"/api/domains/{domain_ids[0]}", json={"registrar_id": reg_id})
        assert r.status_code == 200, r.text

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": domain_ids,
                "server_id": server_id,
                "cloudflare_account_id": cf_id,
            },
        )
        assert r.status_code == 200, r.text
        assert (await _stored(domain_ids))[domain_ids[0]]["registrar_id"] == reg_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body,expected_loc",
    [
        # Инвариант ZK: токену Cloudflare в теле сервера делать нечего — шаг
        # зоны живёт в десктопе. Незнакомое поле обязано быть отказом.
        pytest.param({"api_token": "cf-plaintext"}, ["body", "api_token"], id="unknown-field"),
        # Пустая пачка — дефект вызывающего: экран зовёт full-setup по
        # выделению.
        pytest.param({"domain_ids": []}, ["body", "domain_ids"], id="empty-domain-ids"),
    ],
)
async def test_bad_body_is_a_refusal_not_silence(body: dict, expected_loc: list):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "fs-422")
        server_id = await _create_server(c)
        cf_id = await _create_cf_account(c)
        domain_ids = await _create_domains(c, 1)

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": domain_ids,
                "server_id": server_id,
                "cloudflare_account_id": cf_id,
                **body,
            },
        )
        assert r.status_code == 422, r.text
        assert [e["loc"] for e in r.json()["detail"]] == [expected_loc], r.text
        # Отказ полный: остальные поля тела валидны, но связки не проставлены.
        assert (await _stored(domain_ids))[domain_ids[0]]["server_id"] is None


@pytest.mark.asyncio
async def test_audit_records_counters_not_id_lists():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "fs-audit")
        server_id = await _create_server(c)
        cf_id = await _create_cf_account(c)
        domain_ids = await _create_domains(c, 2)

        r = await c.post(
            "/api/domains/full-setup",
            json={
                "domain_ids": [*domain_ids, 2_000_000_000],
                "server_id": server_id,
                "cloudflare_account_id": cf_id,
            },
        )
        assert r.status_code == 200, r.text

        rows = (await c.get("/api/audit/log")).json()
        matching = [row for row in rows if row["action"] == "domain.full_setup"]
        assert matching, "full-setup не оставил записи в аудите"
        meta = matching[0]["metadata"]
        assert meta == {
            "server_id": server_id,
            "cloudflare_account_id": cf_id,
            "registrar_id": None,
            "domains_requested": 3,
            "domains_linked": 2,
            "domains_skipped": 1,
        }
        for key, value in meta.items():
            assert not isinstance(value, (list, dict)), (
                f"в аудит попал перечень вместо счётчика: {key}={value!r}"
            )
