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

Сюда же попала достижимость выгрузки `failed-export.csv`: она читает ровно тот
результат провижининга, который сюда пишет десктоп (`status`,
`last_provision_error`), и до cleanup-спринта была недостижима — статик-маршрут
стоял ниже `GET /{domain_id}` и отвечал 422.

Кросс-юзерные 404 здесь снабжены **позитивным контролем URL**: тот же метод по
тому же пути под владельцем обязан вернуть 200. Без него опечатка в пути
(`/api/domain/{id}`, переставленный роут) давала бы тот же 404, и тест
«чужому нельзя» зеленел бы там, где эндпоинта нет вовсе.
"""

import asyncio
import base64
import csv
import io
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
            "wrapped_vault_key_b64": b64(b"\x04" * 72),
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
async def test_domain_update_accepts_ftp_and_db_password_blob_ids():
    """`PUT /api/domains/{id}` принимает `ftp_password_blob_id` и `db_password_blob_id`.

    Фаза 4: provision генерирует пароли FTP и БД на сервере и больше нигде их не
    хранит. Фронт шифрует их в блобы и присылает СЮДА только id блобов —
    плейнтекст на сервер не уходит (инвариант ZK). До фазы 4 схема `DomainUpdate`
    поле `db_password_blob_id` не принимала, и id молча пропадал.

    Проверка round-trip через `GET`: id действительно легли в колонки. Блобы
    заводятся заранее — на `*_password_blob_id` стоит FK на `blob_storage`.
    """
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    ftp_blob = str(uuid.uuid4())
    db_blob = str(uuid.uuid4())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-blob-{uuid.uuid4().hex[:8]}@example.com")
        # Оба блоба должны существовать: иначе FK отобьёт PUT.
        for bid, kind in ((ftp_blob, "domain_ftp_password"), (db_blob, "domain_db_password")):
            r = await c.put(
                f"/api/blobs/{bid}",
                json={"blob_kind": kind, "ciphertext_b64": b64(b"cipher")},
            )
            assert r.status_code == 200, r.text
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        try:
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={"ftp_password_blob_id": ftp_blob, "db_password_blob_id": db_blob},
            )
            assert r.status_code == 200, r.text

            body = (await c.get(f"/api/domains/{domain_id}")).json()
            assert body["ftp_password_blob_id"] == ftp_blob
            assert body["db_password_blob_id"] == db_blob
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
                # по ним есть что перебирать. Спрашиваем именно про `domain.update`:
                # под фильтр выше подходит и `domain.create` от POST выше по тесту,
                # и на ней контроль был бы удовлетворён при полностью убранном
                # аудите у PUT — то есть перебор снова стал бы холостым.
                assert any(r.action == "domain.update" for r in audit_rows), (
                    "PUT не оставил следа в аудите — перебор ниже холостой"
                )
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
async def test_failed_export_csv_is_reachable_and_contains_the_failed_domain():
    """`GET /api/domains/failed-export.csv` отдаёт CSV, а не ошибку разбора пути.

    Статик-маршрут жил в файле **ниже** `GET /{domain_id}`, а Starlette
    перебирает маршруты в порядке объявления: `failed-export.csv` попадал в
    динамический, не парсился в `int` и возвращал 422. Выгрузка провалившихся
    доменов была недостижима с самого своего появления.

    Проверяется не только статус и `Content-Type`, но и тело: 200 с
    `text/csv` вернул бы и пустой ответ, и чужой CSV. Здесь разбирается
    заголовок колонок и ищется строка ровно про тот домен, который тест только
    что уронил, — с его текстом ошибки. Это же и позитивный контроль: если
    выборка перестанет отбирать `status = failed`, строки не окажется.
    """
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    err = "provision failed at create_site: the command failed on the server"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-csv-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201, r.text
        domain_id = r.json()["id"]
        try:
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={"status": "failed", "last_provision_error": err},
            )
            assert r.status_code == 200, r.text

            r = await c.get("/api/domains/failed-export.csv")
            assert r.status_code == 200, (
                f"статик-маршрут затенён динамическим `/{{domain_id}}`: {r.text}"
            )
            assert r.headers["content-type"].startswith("text/csv"), r.headers["content-type"]
            assert "failed_domains.csv" in r.headers.get("content-disposition", "")

            rows = list(csv.reader(io.StringIO(r.text)))
            assert rows[0] == [
                "domain_name",
                "status",
                "last_provision_error",
                "updated_at",
            ], rows[0]
            row = next((x for x in rows[1:] if x[0] == dom), None)
            assert row is not None, f"упавшего домена нет в выгрузке: {rows}"
            assert row[1] == "failed", row
            assert row[2] == err, row
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
async def test_server_write_rejects_credentials_in_url_and_control_chars_in_user():
    """URL панели со встроенными кредами не доезжает до колонки — 422.

    `https://admin:s3cr3t@ip:8888/` — это пароль панели внутри значения. Обе
    линии обороны его пропускали: регекс парсера в десктопе такой токен матчит,
    а гард редакции аудита смотрит на **имена** полей, и имя `url` секретным не
    выглядит. Схема — последняя дверь, общая для любого клиента, а не только
    для нашего десктопа.

    Проверяются обе схемы записи, `ServerUpdate` и `ServerCreate`: валидаторы
    объявлены на каждой отдельно, и без второго случая снятие проверки с
    `ServerCreate` не уронило бы ничего. `POST` — не теоретический путь: форму
    «Connect Existing Fastpanel» (`frontend/src/pages/Servers.tsx`) пользователь
    заполняет URL'ом руками, и `https://admin:pass@host:8888` он туда впишет
    ровно так же, как в браузер.

    Проверка по БД, а не по коду ответа: 422 сам по себе не доказывает, что
    запись не состоялась (сервис мог бы успеть записать до валидации — не в
    FastAPI, но тест не должен держаться на этом знании). Колонки после отказа
    обязаны остаться такими, какими их создал POST.

    Позитивный контроль в конце: тот же метод, путь и форма тела с чистым URL
    дают 200 и пишут значение. Без него 422 могло бы приходить от опечатки в
    пути или от `extra="forbid"` на незнакомом поле, и тест зеленел бы, не
    проверив валидатор.
    """
    ip = "203.0.113.10"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-url-{uuid.uuid4().hex[:8]}@example.com")

        # `ServerCreate`: сервер с таким URL не заводится вовсе.
        rejected_name = f"srv-{uuid.uuid4().hex[:6]}"
        r = await c.post(
            "/api/servers",
            json={
                "name": rejected_name,
                "ip_address": ip,
                "fastpanel_status": "installed",
                "fastpanel_url": f"https://admin:s3cr3t@{ip}:8888/",
            },
        )
        assert r.status_code == 422, r.text
        assert [e["loc"] for e in r.json()["detail"]] == [["body", "fastpanel_url"]], r.text
        assert "s3cr3t" not in r.text, r.text
        async with AsyncSessionLocal() as s:
            created = (
                await s.execute(select(Server).where(Server.name == rejected_name))
            ).scalars().all()
            assert created == [], "отвергнутый POST всё-таки завёл сервер"

        r = await c.post(
            "/api/servers",
            json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": ip},
        )
        assert r.status_code == 201, r.text
        server_id = r.json()["id"]
        try:
            for field, payload in (
                (
                    "fastpanel_url",
                    {
                        "fastpanel_status": "installed",
                        "fastpanel_url": f"https://admin:s3cr3t@{ip}:8888/",
                        "fastpanel_user": "fastuser",
                    },
                ),
                (
                    "fastpanel_user",
                    {
                        "fastpanel_status": "installed",
                        "fastpanel_url": f"https://{ip}:8888/",
                        "fastpanel_user": "fast\nuser",
                    },
                ),
            ):
                r = await c.put(f"/api/servers/{server_id}", json=payload)
                assert r.status_code == 422, r.text
                assert [e["loc"] for e in r.json()["detail"]] == [["body", field]], r.text
                if field == "fastpanel_url":
                    # Отказ не должен вернуть присланное обратно: `input` в 422
                    # уезжает во фронтовые логи и в лог прокси (см.
                    # `validation_error_without_secret_input` в `main.py`), а
                    # этот отказ срабатывает ровно тогда, когда в значении сидит
                    # пароль панели. Про `fastpanel_user` условия нет намеренно:
                    # логин секретом не является, и его `input` в ответе
                    # остаётся — иначе разбор 422 стал бы гаданием.
                    assert "s3cr3t" not in r.text, r.text

                async with AsyncSessionLocal() as s:
                    server = (
                        await s.execute(select(Server).where(Server.id == server_id))
                    ).scalar_one()
                    assert server.fastpanel_url is None
                    assert server.fastpanel_user is None
                    # Соседние поля того же тела тоже не должны были записаться.
                    assert server.fastpanel_status == "not_installed"

            r = await c.put(
                f"/api/servers/{server_id}",
                json={
                    "fastpanel_status": "installed",
                    "fastpanel_url": f"https://{ip}:8888/",
                    "fastpanel_user": "fastuser",
                },
            )
            assert r.status_code == 200, r.text
            async with AsyncSessionLocal() as s:
                server = (
                    await s.execute(select(Server).where(Server.id == server_id))
                ).scalar_one()
                assert server.fastpanel_url == f"https://{ip}:8888/"
                assert server.fastpanel_user == "fastuser"
        finally:
            await _purge(Server, server_id)


# Строки сервера, которые заполняет клиент, и значения, не влезающие в их
# колонки. До этого круга ни одно из четырёх полей не проверялось ничем:
# `POST /api/servers` с таким значением доезжал до драйвера и возвращал 500
# (`StringDataRightTruncation` или `DataError: surrogates not allowed`) вместо
# 422 с именем поля. Тот же класс, что уже закрыт у `provider` и метрик.
CLIENT_TEXT_CASES = [
    pytest.param("name", "x" * 256, id="name-длиннее-колонки"),
    pytest.param("name", "A\ud800B", id="name-с-суррогатом"),
    pytest.param("name", "srv\nfake", id="name-с-переводом-строки"),
    pytest.param("ip_address", "A\ud800B", id="ip_address-с-суррогатом"),
    pytest.param("ssh_user", "ro\not", id="ssh_user-с-переводом-строки"),
    pytest.param("os", "x" * 65, id="os-длиннее-колонки"),
]


@pytest.mark.parametrize("field,value", CLIENT_TEXT_CASES)
@pytest.mark.asyncio
async def test_client_string_that_cannot_fit_the_column_is_422_not_500(field: str, value: str):
    """Строка, не влезающая в колонку, — 422, и ни строки в БД, ни правки.

    Проверяются обе схемы записи: валидаторы объявлены на `ServerCreate` и
    `ServerUpdate` порознь (`ServerResponse` наследует ту же базу и собирается
    из ORM, поэтому на общей базе проверка отвергала бы ЧТЕНИЕ уже лежащих
    строк), и без второго случая снятие проверки с правки не уронило бы
    ничего.

    Утверждения по БД, а не по коду ответа: 422 сам по себе говорит лишь
    «схема чем-то недовольна». У создания важно, что строки не появилось, у
    правки — что прежнее значение выжило.

    Позитивный контроль в конце: та же форма тела с законным значением даёт
    200 и пишет его. Без него 422 мог бы приходить от чего угодно — например,
    от опечатки в имени поля, — и тест был бы зелен, не проверив валидатор.
    """
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"wb-col-{uuid.uuid4().hex[:8]}@example.com")

        rejected_name = f"srv-{uuid.uuid4().hex[:6]}"
        body = {"name": rejected_name, "ip_address": "203.0.113.12", field: value}
        r = await c.post("/api/servers", json=body)
        assert r.status_code == 422, r.text
        assert [list(e["loc"]) for e in r.json()["detail"]] == [["body", field]], r.text
        async with AsyncSessionLocal() as s:
            created = (
                await s.execute(select(Server.id).where(Server.name == rejected_name))
            ).scalars().all()
            assert created == [], "отвергнутый POST всё-таки завёл сервер"

        r = await c.post(
            "/api/servers",
            json={"name": f"srv-{uuid.uuid4().hex[:6]}", "ip_address": "203.0.113.12"},
        )
        assert r.status_code == 201, r.text
        server_id = r.json()["id"]
        try:
            async with AsyncSessionLocal() as s:
                before = getattr(
                    (await s.execute(select(Server).where(Server.id == server_id))).scalar_one(),
                    field,
                )

            r = await c.put(f"/api/servers/{server_id}", json={field: value})
            assert r.status_code == 422, r.text
            assert [list(e["loc"]) for e in r.json()["detail"]] == [["body", field]], r.text
            async with AsyncSessionLocal() as s:
                after = getattr(
                    (await s.execute(select(Server).where(Server.id == server_id))).scalar_one(),
                    field,
                )
            assert after == before, "отвергнутый PUT всё-таки переписал колонку"

            legal = {"name": "srv-legal", "ip_address": "203.0.113.13", "ssh_user": "root",
                     "os": "ubuntu-22.04"}[field]
            r = await c.put(f"/api/servers/{server_id}", json={field: legal})
            assert r.status_code == 200, (
                f"законное значение тоже отвергнуто — проверка ловит не то: {r.text}"
            )
            async with AsyncSessionLocal() as s:
                stored = getattr(
                    (await s.execute(select(Server).where(Server.id == server_id))).scalar_one(),
                    field,
                )
            assert stored == legal
        finally:
            await _purge(Server, server_id)


@pytest.mark.asyncio
async def test_user_b_cannot_write_back_to_user_a_domain():
    """Чужой домен не обновляется через `PUT` — 404, значения не меняются.

    С позитивным контролем URL: ровно тот же метод, путь и тело под владельцем
    обязаны дать 200. Без него 404 у чужого не доказывает ничего — его же
    вернула бы опечатка в пути или переставленный роут, и тест «чужому нельзя»
    был бы зелен в мире, где эндпоинта нет вовсе. `GET` вместо `PUT` в этой
    роли не годится: у него свой обработчик, и он живёт даже когда `PUT` не
    зарегистрирован.
    """
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

            # позитивный контроль: путь настоящий и запрос рабочий
            r = await c.put(f"/api/domains/{domain_id}", json=hijack)
            assert r.status_code == 200, (
                f"этот же PUT не работает и у владельца — 404 у чужого "
                f"ничего не доказывает: {r.text}"
            )
            assert r.json()["site_user"] == "hijack"
        finally:
            await _purge(Domain, domain_id)


@pytest.mark.asyncio
async def test_user_b_cannot_write_back_to_user_a_server():
    """Чужой сервер не обновляется через `PUT` — 404, значения не меняются.

    С позитивным контролем URL — по тем же соображениям, что и у домена выше.
    """
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

            # позитивный контроль: путь настоящий и запрос рабочий
            r = await c.put(f"/api/servers/{server_id}", json=hijack)
            assert r.status_code == 200, (
                f"этот же PUT не работает и у владельца — 404 у чужого "
                f"ничего не доказывает: {r.text}"
            )
            assert r.json()["fastpanel_user"] == "hijack"
        finally:
            await _purge(Server, server_id)
