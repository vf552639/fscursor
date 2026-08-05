"""Хостинг-провайдер сервера: что доезжает до колонки `servers.provider`.

Проверка идёт **по колонке БД**, а не по телу ответа, и это не формальность.
Урок проекта записан в шапке `test_secret_write_path.py`: тест «секрета нет в
ответе» был зелёным ровно потому, что поля в ответе не существовало вовсе, —
он остался бы зелёным и в мире, где сервер пишет плейнтекст в колонку. Тот же
силуэт ошибки возможен и здесь, только зеркальный: ассерт
`r.json()["provider"] == "Hetzner"` зеленеет от одного эха запроса и молчит,
если значение до колонки не доехало (например, `server_service.create` начнёт
исключать поле из `model_dump`). Поэтому утверждения — про строку в `servers`.

Отдельная причина смотреть в БД у отказов: 422 сам по себе доказывает только
то, что схема чем-то недовольна. Что при этом НЕ произошло записи — видно
исключительно в колонке, и у правки это главное: старое значение обязано
пережить отвергнутый PUT.

Ответ проверяется ровно один раз и отдельным тестом — там, где предметом и
является форма ответа: без `provider` в `ServerResponse` карточка сервера и
`datalist` подсказок (фазы 2–3 плана `plans/2026-08-05-server-hosting-provider.md`)
не увидят значения, сколь угодно правильно лежащего в БД. Читается оно из GET,
который сервер собирает из БД, а не из тела POST.
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
from app.core.validators import PROVIDER_MAX_LEN
from app.main import app
from app.models.server import Server

_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
    """Убрать пользователей теста — серверы уедут за ними по FK CASCADE.

    База тестов общая с dev-окружением (см. `test_secret_write_path.py`), а
    упавший ассерт обрывает тест на середине, поэтому уборка живёт в teardown,
    а не в `finally` каждого случая.
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


async def _stored_provider(server_id: int) -> object:
    """Значение колонки `servers.provider` — прямо из БД, мимо схемы ответа."""
    async with AsyncSessionLocal() as s:
        return (
            await s.execute(select(Server.provider).where(Server.id == server_id))
        ).scalar_one()


def _provider_error_locs(response) -> list[list[str]]:
    """`loc` ошибок валидации именно про `provider`.

    Смотрим на `loc`, а не на статус: 422 схема отдаёт и за десяток других
    причин (нет `name`, кривой `ssh_port`), и тест, довольный любым 422,
    зеленел бы на опечатке в теле запроса.
    """
    return [list(e["loc"]) for e in response.json()["detail"] if list(e["loc"])[-1] == "provider"]


async def _login_and_create(c: AsyncClient, prefix: str, **extra) -> tuple[int, dict]:
    """Завести пользователя и сервер; вернуть id и тело ответа."""
    await _register_and_login(c, f"{prefix}-{uuid.uuid4().hex[:8]}@example.com")
    r = await c.post(
        "/api/servers",
        json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": "203.0.113.30", **extra},
    )
    assert r.status_code == 201, r.text
    return r.json()["id"], r.json()


@pytest.mark.asyncio
async def test_provider_lands_in_the_column_on_create_and_on_update():
    """POST кладёт провайдера в колонку, PUT его меняет.

    Оба перехода нужны порознь: путь записи у них разный
    (`server_service.create` собирает сущность из `model_dump()`, `update` —
    патчит через `model_dump(exclude_unset=True)`), и поле, забытое в одной из
    двух схем, второй не подстраховано.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        # Пробел внутри имени — законная часть («Hetzner Online», «OVH Cloud»),
        # и провайдер тем и отличается от логина панели, где пробел запрещён.
        server_id, _ = await _login_and_create(c, "prov", provider="Hetzner Online")

        assert await _stored_provider(server_id) == "Hetzner Online", (
            "провайдер не доехал до колонки при создании"
        )

        r = await c.put(f"/api/servers/{server_id}", json={"provider": "OVH"})
        assert r.status_code == 200, r.text
        assert await _stored_provider(server_id) == "OVH", (
            "правка провайдера не доехала до колонки"
        )


@pytest.mark.asyncio
async def test_provider_is_readable_back_from_the_api():
    """GET списка отдаёт провайдера — иначе карточка и фильтр его не увидят.

    Единственный в файле ассерт по ответу, и он про свой предмет: значение,
    правильно лежащее в БД, но не объявленное в `ServerResponse`, для фаз 2–3
    не существует. Читается из GET, а не из ответа POST: строки списка сервер
    собирает из БД, так что эхом запроса это быть не может.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id, _ = await _login_and_create(c, "prov-read", provider="Hetzner")

        r = await c.get("/api/servers")
        assert r.status_code == 200, r.text
        listed = next(s for s in r.json()["items"] if s["id"] == server_id)
        assert listed.get("provider") == "Hetzner", (
            "провайдера нет в ответе API — UI не сможет его показать"
        )


@pytest.mark.asyncio
async def test_control_character_in_provider_never_reaches_the_column():
    """`\\n` в провайдере — 422, и при создании, и при правке.

    Управляющий символ уезжает в колонку, в UI и в metadata аудита как есть:
    одна запись аудита превращается в две, вторая из которых выглядит
    настоящей. Проверка отказа идёт по БД, потому что 422 сам по себе говорит
    лишь «схема чем-то недовольна»: у создания нужно, чтобы строки не
    появилось, у правки — чтобы прежнее значение выжило.
    """
    dirty = "Het\nzner"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id, _ = await _login_and_create(c, "prov-ctrl", provider="Hetzner")

        name = f"srv-{uuid.uuid4().hex[:6]}"
        r = await c.post(
            "/api/servers",
            json={"name": name, "ip_address": "203.0.113.31", "provider": dirty},
        )
        assert r.status_code == 422, r.text
        assert _provider_error_locs(r) == [["body", "provider"]], r.text
        async with AsyncSessionLocal() as s:
            created = (
                await s.execute(select(Server.id).where(Server.name == name))
            ).scalar_one_or_none()
        assert created is None, "отвергнутый POST всё-таки завёл сервер"

        r = await c.put(f"/api/servers/{server_id}", json={"provider": dirty})
        assert r.status_code == 422, r.text
        assert _provider_error_locs(r) == [["body", "provider"]], r.text
        assert await _stored_provider(server_id) == "Hetzner", (
            "отвергнутый PUT всё-таки переписал колонку"
        )


@pytest.mark.asyncio
async def test_provider_longer_than_the_column_is_rejected_at_the_boundary():
    """Ровно ширина колонки проходит, на символ длиннее — 422.

    Граница проверяется с обеих сторон: без верхнего случая проверка длины
    могла бы отвергать вообще всё, без нижнего — 65-й символ дошёл бы до
    Postgres и вернулся `StringDataRightTruncation`, то есть 500 вместо 422.
    """
    exact = "x" * PROVIDER_MAX_LEN
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id, _ = await _login_and_create(c, "prov-len", provider=exact)
        assert await _stored_provider(server_id) == exact

        r = await c.put(f"/api/servers/{server_id}", json={"provider": "x" * (PROVIDER_MAX_LEN + 1)})
        assert r.status_code == 422, r.text
        assert _provider_error_locs(r) == [["body", "provider"]], r.text
        assert await _stored_provider(server_id) == exact, (
            "слишком длинное значение переписало колонку"
        )


@pytest.mark.asyncio
async def test_blank_provider_is_stored_as_null_and_edges_are_trimmed():
    """Пустое поле формы — это NULL, а обрамляющие пробелы срезаются.

    И то, и другое — про группировку: провайдер служит ключом `datalist` и
    фильтра (фазы 2–3), а `""` и `"Hetzner "` дали бы в них лишние «отдельные»
    значения, которых пользователь не поймёт. Ассерт по колонке: в теле ответа
    `""` и `NULL` в JSON различимы, но именно в колонке они порождают разные
    строки фильтра.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        server_id, _ = await _login_and_create(c, "prov-blank", provider="   ")
        assert await _stored_provider(server_id) is None, (
            "пустое поле формы записалось как пустая строка, а не NULL"
        )

        r = await c.put(f"/api/servers/{server_id}", json={"provider": "  Hetzner  "})
        assert r.status_code == 200, r.text
        assert await _stored_provider(server_id) == "Hetzner", (
            "обрамляющие пробелы доехали до колонки — фильтр получит двойника"
        )
