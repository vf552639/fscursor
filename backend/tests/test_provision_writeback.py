"""Write-back результатов provision с десктопа в серверные метаданные.

Десктоп выполняет provision (SSH, сайт, SSL, FastPanel) и должен возвращать
результат на сервер через обычный `PUT`. Раньше схемы `DomainUpdate`/
`ServerUpdate` часть этих полей не принимали, поэтому серверные проверки
идемпотентности (`ssl_status`, `fastpanel_status`, …) читали колонки, которые
никто не заполнял.

Инвариант ZK: write-back — это метаданные, но не секреты. Пароли на сервер не
уезжают, поэтому здесь проверяется в том числе, что плейнтекст-пароль в
`PUT` игнорируется и в ответе/БД не появляется.
"""

import base64
import uuid
from datetime import datetime, timezone

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _register_and_login(client: AsyncClient, email: str, key: bytes = b"\x01" * 32) -> None:
    await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(key),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
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
        json={"email": email, "auth_key_b64": b64(key)},
    )


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
            await c.delete(f"/api/domains/{domain_id}")


@pytest.mark.asyncio
async def test_domain_update_ignores_plaintext_password_fields():
    """Инвариант ZK: плейнтекст-пароль в `PUT` не сохраняется и не возвращается.

    Пароли живут только в зашифрованных блобах (`*_password_blob_id`), поэтому
    расширение схемы полями результата не должно открыть канал для секретов.
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
            assert secret not in r.text

            r = await c.get(f"/api/domains/{domain_id}")
            assert r.status_code == 200, r.text
            assert secret not in r.text
            assert r.json()["db_user"] == "dbu"
        finally:
            await c.delete(f"/api/domains/{domain_id}")


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
            await c.delete(f"/api/servers/{server_id}")


@pytest.mark.asyncio
async def test_user_b_cannot_write_back_to_user_a_domain():
    """Чужой домен не обновляется через `PUT` — 404, значения не меняются."""
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    a_email = f"wb-a-{uuid.uuid4().hex[:8]}@example.com"
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
            r = await c.put(
                f"/api/domains/{domain_id}",
                json={"site_user": "hijack", "ssl_status": "active"},
            )
            assert r.status_code == 404, r.text

            # владелец видит домен нетронутым
            await c.post("/api/auth/logout")
            await _register_and_login(c, a_email)
            r = await c.get(f"/api/domains/{domain_id}")
            assert r.status_code == 200, r.text
            assert r.json()["site_user"] is None
        finally:
            await c.delete(f"/api/domains/{domain_id}")


@pytest.mark.asyncio
async def test_user_b_cannot_write_back_to_user_a_server():
    """Чужой сервер не обновляется через `PUT` — 404, значения не меняются."""
    a_email = f"wb-sa-{uuid.uuid4().hex[:8]}@example.com"
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
            r = await c.put(
                f"/api/servers/{server_id}",
                json={"fastpanel_status": "installed", "fastpanel_user": "hijack"},
            )
            assert r.status_code == 404, r.text

            await c.post("/api/auth/logout")
            await _register_and_login(c, a_email)
            r = await c.get(f"/api/servers/{server_id}")
            assert r.status_code == 200, r.text
            assert r.json()["fastpanel_status"] == "not_installed"
            assert r.json()["fastpanel_user"] is None
        finally:
            await c.delete(f"/api/servers/{server_id}")
