"""Write-back результатов provision с десктопа в серверные метаданные.

Десктоп выполняет provision (SSH, сайт, SSL, FastPanel) и должен возвращать
результат на сервер через обычный `PUT`. Раньше схемы `DomainUpdate`/
`ServerUpdate` часть этих полей не принимали, поэтому серверные проверки
идемпотентности (`ssl_status`, `fastpanel_status`, …) читали колонки, которые
никто не заполнял.

Инвариант ZK: write-back — это метаданные, но не секреты. Пароли на сервер не
уезжают, поэтому здесь проверяется в том числе, что плейнтекст-пароль в `PUT`
никуда не записывается.

Проверка — **по БД**, а не по тексту ответа. Ассерт `secret not in r.text`,
живший здесь до Спринта 4, был зелёным ровно потому, что в `DomainResponse`
нет поля под пароль: он остался бы зелёным и в мире, где рядом заведена
плейнтекст-колонка и сервис только что записал в неё пароль. Утверждение,
верное при любой реализации, — это не проверка. Вместо него — перебор всех
колонок маппера `Domain` (переживёт добавление новой колонки) плюс перебор
строк аудита, которые породил тот же `PUT`.
"""

import asyncio
import base64
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete as sa_delete
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select, update

from app.audit.models import AuditLog
from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app
from app.models.domain import Domain
from app.models.server import Server


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


# Пользователи, заведённые текущим тестом (образец — `test_secret_write_path`).
# Каждый тест файла регистрирует своих, а удалять их было некому: в общей
# dev-БД копились `wb-*`.
_REGISTERED_EMAILS: list[str] = []


@pytest.fixture(autouse=True)
def _purge_users_registered_by_this_test():
    """Убрать пользователей теста — их хозяйство уедет следом по FK CASCADE.

    Уборка в teardown, а не в `finally` каждого теста: забыть `finally` в новом
    тесте куда легче, чем не заметить пропавшую фикстуру. `asyncio.run` в
    синхронной фикстуре безопасен — пул `NullPool`, соединение заводится под
    текущий цикл и им же закрывается (см. `core/database`).
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


def _leaks(value: object, secret: str) -> bool:
    """Видно ли секрет в значении колонки — хоть текстом, хоть байтами."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return secret.encode() in bytes(value)
    return secret in str(value)


async def _login(client: AsyncClient, email: str, key: bytes = b"\x01" * 32) -> None:
    """Залогиниться уже существующим пользователем."""
    r = await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(key)},
    )
    assert r.status_code == 200, r.text


async def _register_and_login(client: AsyncClient, email: str, key: bytes = b"\x01" * 32) -> None:
    """Зарегистрировать нового пользователя, подтвердить почту и войти."""
    _REGISTERED_EMAILS.append(email)
    r = await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(key),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
        },
    )
    # 409 — почта уже занята: тесты берут случайные адреса, так что это
    # практически невозможно, но повторный прогон с тем же адресом должен
    # доехать до логина, а не падать здесь. Всё остальное — настоящая ошибка.
    assert r.status_code in (201, 409), r.text
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    await _login(client, email, key)


async def _purge(model: type, entity_id: int) -> None:
    """Удалить строку напрямую в БД, не завися от того, кто сейчас залогинен.

    Тесты с двумя пользователями заканчиваются в сессии произвольного из них,
    а падение load-bearing-ассерта может оборвать их на середине. Удаление
    через API в таком случае само получило бы 404, и строка навсегда осталась
    бы в общей dev-базе.
    """
    async with AsyncSessionLocal() as s:
        await s.execute(sa_delete(model).where(model.id == entity_id))
        await s.commit()


@pytest.mark.asyncio
async def test_domain_update_accepts_provision_result_fields():
    """`PUT /api/domains/{id}` принимает и сохраняет результат provision."""
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    expires = datetime(2027, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
    payload = {
        "site_user": "usr_" + uuid.uuid4().hex[:6],
        "site_path": "/var/www/usr/data/www/" + dom,
        "ssl_status": "active",
        "ssl_expires_at": expires.isoformat(),
        "ssl_issuer": "Let's Encrypt",
        "db_name": "db_" + uuid.uuid4().hex[:6],
        "db_user": "dbu_" + uuid.uuid4().hex[:6],
        "last_provision_error": "",
        "status": "active",
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-dom-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        try:
            r = await c.put(f"/api/domains/{domain_id}", json=payload)
            assert r.status_code == 200, r.text

            # round-trip через GET: значения действительно легли в БД
            r = await c.get(f"/api/domains/{domain_id}")
            assert r.status_code == 200, r.text
            body = r.json()
            for key in (
                "site_user",
                "site_path",
                "ssl_status",
                "ssl_issuer",
                "db_name",
                "db_user",
                "last_provision_error",
                "status",
            ):
                assert body[key] == payload[key], f"{key}: {body[key]!r} != {payload[key]!r}"
            assert datetime.fromisoformat(body["ssl_expires_at"]) == expires
        finally:
            await _purge(Domain, domain_id)


@pytest.mark.asyncio
async def test_domain_update_clears_last_provision_error_with_explicit_null():
    """Явный `null` сбрасывает `last_provision_error` в NULL.

    `domain_service.update` берёт `model_dump(exclude_unset=True)`, поэтому
    явный `null` и опущенное поле — разные вещи: первое пишет NULL, второе не
    трогает колонку вовсе. Десктоп на этом и держится — после успешного
    повтора он обязан погасить прошлую ошибку, иначе домен навсегда остаётся
    с протухшим текстом в UI. Пустая строка (её ставит соседний тест) — это не
    NULL и такой проверкой не считается.
    """
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-err-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        try:
            # 1. провалившийся provision записал ошибку
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={"last_provision_error": "ssh: connection refused", "status": "failed"},
            )
            assert r.status_code == 200, r.text
            r = await c.get(f"/api/domains/{domain_id}")
            assert r.json()["last_provision_error"] == "ssh: connection refused"

            # 2. поле, которого нет в запросе, не затирается
            r = await c.put(f"/api/domains/{domain_id}", json={"status": "provisioning"})
            assert r.status_code == 200, r.text
            r = await c.get(f"/api/domains/{domain_id}")
            assert r.json()["last_provision_error"] == "ssh: connection refused"

            # 3. явный null гасит ошибку
            r = await c.put(f"/api/domains/{domain_id}", json={"last_provision_error": None})
            assert r.status_code == 200, r.text
            assert r.json()["last_provision_error"] is None
            r = await c.get(f"/api/domains/{domain_id}")
            assert r.status_code == 200, r.text
            assert r.json()["last_provision_error"] is None
        finally:
            await _purge(Domain, domain_id)


@pytest.mark.asyncio
async def test_failed_provision_is_visible_and_keeps_the_earlier_result():
    """Провал провижининга виден в списке доменов и не стирает прошлую правду.

    Ровно те два тела, которые шлёт десктоп (`domain_failure_write_back_body` и
    `domain_write_back_body` в `commands/provision.rs`). До фазы 4 первого не
    существовало: `?` уносил управление до write-back, и упавший прогон не
    писал ничего — «Last error» в UI был вечным «—».

    Проверяется по СПИСКУ (`GET /api/domains`), а не по одиночному домену:
    именно его читает страница доменов, и именно в нём поле обязано доехать.
    """
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    err = "provision failed at create_site: the command failed on the server"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-fail-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        try:
            # 1. удачный прогон записал результат
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={
                    "status": "active",
                    "site_user": "example_usr",
                    "site_path": f"/var/www/example_usr/data/www/{dom}",
                    "ssl_status": "active",
                    "last_provision_error": None,
                },
            )
            assert r.status_code == 200, r.text

            # 2. следующий прогон упал — тело провала ровно из двух полей
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={"status": "failed", "last_provision_error": err},
            )
            assert r.status_code == 200, r.text

            rows = (await c.get("/api/domains")).json()
            row = next(d for d in rows if d["id"] == domain_id)
            assert row["last_provision_error"] == err
            assert row["status"] == "failed"
            # Упавший прогон не вправе стирать добытое удачным: этих полей в
            # его теле нет, и `exclude_unset` их не трогает.
            assert row["site_user"] == "example_usr"
            assert row["ssl_status"] == "active"

            # 3. удавшийся повтор гасит и ошибку, и статус `failed`
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={"status": "active", "last_provision_error": None},
            )
            assert r.status_code == 200, r.text
            rows = (await c.get("/api/domains")).json()
            row = next(d for d in rows if d["id"] == domain_id)
            assert row["last_provision_error"] is None
            assert row["status"] == "active"
        finally:
            await _purge(Domain, domain_id)


@pytest.mark.asyncio
async def test_plaintext_password_in_put_lands_in_no_column_of_the_domain():
    """Инвариант ZK: плейнтекст-пароль в `PUT` не оседает ни в одной колонке.

    Пароли живут только в зашифрованных блобах (`*_password_blob_id`), поэтому
    расширение `DomainUpdate` полями результата provision не должно открыть
    канал для секретов.

    Проверка по БД, а не по `r.text` (см. шапку файла): в `DomainResponse` нет
    поля под пароль, поэтому ассерт по ответу зеленел бы и с записанной
    плейнтекст-колонкой. Перебор идёт по мапперу, а не по паре запомнившихся
    имён: колонку с секретом могут завести завтра, и тест обязан это увидеть.

    Чтобы перебор мог провалиться, плейнтекст **кладётся в тело запроса** —
    сегодня `DomainUpdate` живёт с дефолтным `extra="ignore"`, поле доезжает до
    pydantic и было бы записано, объяви его схема. Если на `DomainUpdate`
    когда-нибудь повесят `extra="forbid"` (Фаза 2 сделала это для
    `Server*`/`Cloudflare*`/`Registrar*`, но не для доменов), `PUT` начнёт
    отдавать 422 — ассерт на 200 упадёт громко, и это правильно: молча
    нефальсифицируемым перебор остаться не должен.

    Аудит проверяется тем же перебором: `PUT` пишет строку `audit_log`, и
    `metadata` там — свободный JSONB, куда тело запроса попадает одной строкой
    кода. «Аудит без секретов» — пятый принцип продукта.
    """
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    secret = f"plaintext-{uuid.uuid4().hex}"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-zk-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        try:
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={
                    "db_user": "dbu",
                    "db_password": secret,
                    "ftp_password": secret,
                    "site_user": "usr",
                },
            )
            assert r.status_code == 200, r.text

            async with AsyncSessionLocal() as s:
                domain = (
                    await s.execute(select(Domain).where(Domain.id == domain_id))
                ).scalar_one()

                # Позитивный контроль: этот же `PUT` действительно что-то
                # записал. Без него перебор ниже был бы зелен и на роуте,
                # который молча не делает ничего.
                assert domain.db_user == "dbu", "PUT не записал даже объявленное поле"

                leaked = [
                    attr.key
                    for attr in sa_inspect(Domain).mapper.column_attrs
                    if _leaks(getattr(domain, attr.key), secret)
                ]
                assert leaked == [], f"плейнтекст виден в колонках domains: {leaked}"

                audit_rows = (
                    await s.execute(
                        select(AuditLog).where(
                            AuditLog.target_type == "domain",
                            AuditLog.target_id == str(domain_id),
                        )
                    )
                ).scalars().all()
                # Тоже позитивный контроль: строки аудита есть, значит перебору
                # по ним есть что перебирать.
                assert audit_rows, "PUT не оставил следа в аудите — перебор ниже холостой"
                audit_leaked = [
                    row.id
                    for row in audit_rows
                    if any(_leaks(getattr(row, attr.key), secret)
                           for attr in sa_inspect(AuditLog).mapper.column_attrs)
                ]
                assert audit_leaked == [], f"плейнтекст виден в audit_log: {audit_leaked}"
        finally:
            await _purge(Domain, domain_id)


@pytest.mark.asyncio
async def test_server_update_accepts_fastpanel_result_fields():
    """`PUT /api/servers/{id}` принимает и сохраняет результат установки FastPanel."""
    payload = {
        "fastpanel_status": "installed",
        "fastpanel_url": "https://203.0.113.10:8888",
        "fastpanel_user": "fp_" + uuid.uuid4().hex[:6],
    }
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-srv-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post(
            "/api/servers",
            json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": "203.0.113.10"},
        )
        assert r.status_code == 201, r.text
        server_id = r.json()["id"]
        assert r.json()["fastpanel_status"] == "not_installed"
        try:
            r = await c.put(f"/api/servers/{server_id}", json=payload)
            assert r.status_code == 200, r.text

            r = await c.get(f"/api/servers/{server_id}")
            assert r.status_code == 200, r.text
            body = r.json()
            for key, value in payload.items():
                assert body[key] == value, f"{key}: {body[key]!r} != {value!r}"
        finally:
            await _purge(Server, server_id)


@pytest.mark.asyncio
async def test_user_b_cannot_write_back_to_user_a_domain():
    """Чужой домен не обновляется через `PUT` — 404, значения не меняются."""
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    a_email = f"wb-a-{uuid.uuid4().hex[:8]}@example.com"
    hijack = {"site_user": "hijack", "ssl_status": "active"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, a_email)
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        try:
            await c.post("/api/auth/logout")
            await _register_and_login(
                c, f"wb-b-{uuid.uuid4().hex[:8]}@example.com", key=b"\x99" * 32
            )
            r = await c.put(f"/api/domains/{domain_id}", json=hijack)
            assert r.status_code == 404, r.text

            # владелец видит домен нетронутым
            await c.post("/api/auth/logout")
            await _login(c, a_email)
            r = await c.get(f"/api/domains/{domain_id}")
            assert r.status_code == 200, r.text
            assert r.json()["site_user"] is None
        finally:
            await _purge(Domain, domain_id)


@pytest.mark.asyncio
async def test_user_b_cannot_write_back_to_user_a_server():
    """Чужой сервер не обновляется через `PUT` — 404, значения не меняются."""
    a_email = f"wb-sa-{uuid.uuid4().hex[:8]}@example.com"
    hijack = {"fastpanel_status": "installed", "fastpanel_user": "hijack"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, a_email)
        r = await c.post(
            "/api/servers",
            json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": "203.0.113.11"},
        )
        assert r.status_code == 201, r.text
        server_id = r.json()["id"]
        try:
            await c.post("/api/auth/logout")
            await _register_and_login(
                c, f"wb-sb-{uuid.uuid4().hex[:8]}@example.com", key=b"\x99" * 32
            )
            r = await c.put(f"/api/servers/{server_id}", json=hijack)
            assert r.status_code == 404, r.text

            await c.post("/api/auth/logout")
            await _login(c, a_email)
            r = await c.get(f"/api/servers/{server_id}")
            assert r.status_code == 200, r.text
            assert r.json()["fastpanel_status"] == "not_installed"
            assert r.json()["fastpanel_user"] is None
        finally:
            await _purge(Server, server_id)
