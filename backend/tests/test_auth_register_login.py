import base64
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


@pytest.mark.asyncio
async def test_register_login_me_logout_flow():
    email = f"alice-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post(
            "/api/auth/register",
            json={
                "email": email,
                "salt_b64": b64(b"\x00" * 16),
                "auth_key_b64": b64(b"\x01" * 32),
                "recovery_blob_b64": b64(b"\x02" * 96),
                "recovery_auth_key_b64": b64(b"\x03" * 32),
                "wrapped_vault_key_b64": b64(b"\x04" * 72),
            },
        )
        assert r.status_code == 201

        from datetime import datetime, timezone

        async with AsyncSessionLocal() as s:
            await s.execute(
                update(User)
                .where(User.email == email)
                .values(
                    email_confirmed_at=datetime.now(timezone.utc),
                    email_confirm_token_hash=None,
                )
            )
            await s.commit()

        r = await c.post("/api/auth/login/start", json={"email": email})
        assert r.status_code == 200
        assert "salt_b64" in r.json()

        r = await c.post(
            "/api/auth/login/finish",
            json={
                "email": email,
                "auth_key_b64": b64(b"\x01" * 32),
            },
        )
        assert r.status_code == 200, r.text

        r = await c.get("/api/auth/me")
        assert r.status_code == 200
        assert r.json()["email"] == email

        r = await c.post("/api/auth/logout")
        assert r.status_code == 204

        r = await c.get("/api/auth/me")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_register_duplicate_email_returns_409():
    dup_email = f"dup-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        body = {
            "email": dup_email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
            "recovery_auth_key_b64": b64(b"\x03" * 32),
            "wrapped_vault_key_b64": b64(b"\x04" * 72),
        }
        r1 = await c.post("/api/auth/register", json=body)
        assert r1.status_code == 201
        r2 = await c.post("/api/auth/register", json=body)
        assert r2.status_code == 409


@pytest.mark.asyncio
async def test_login_finish_wrong_password_returns_401():
    email = f"bob-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await c.post(
            "/api/auth/register",
            json={
                "email": email,
                "salt_b64": b64(b"\x00" * 16),
                "auth_key_b64": b64(b"\x01" * 32),
                "recovery_blob_b64": b64(b"\x02" * 96),
                "recovery_auth_key_b64": b64(b"\x03" * 32),
                "wrapped_vault_key_b64": b64(b"\x04" * 72),
            },
        )
        r = await c.post(
            "/api/auth/login/finish",
            json={
                "email": email,
                "auth_key_b64": b64(b"\x99" * 32),
            },
        )
        assert r.status_code == 401
