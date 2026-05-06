import base64
import uuid

import pyotp
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


@pytest.mark.asyncio
async def test_totp_enable_and_login_with_code():
    from datetime import datetime, timezone

    email = f"totp-{uuid.uuid4().hex[:10]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await c.post(
            "/api/auth/register",
            json={
                "email": email,
                "salt_b64": b64(b"\x00" * 16),
                "auth_key_b64": b64(b"\x01" * 32),
                "recovery_blob_b64": b64(b"\x02" * 96),
            },
        )
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
        await c.post(
            "/api/auth/login/finish",
            json={
                "email": email,
                "auth_key_b64": b64(b"\x01" * 32),
            },
        )
        r = await c.post("/api/auth/totp/enable")
        assert r.status_code == 200
        secret = r.json()["secret"]
        await c.post("/api/auth/logout")
        r = await c.post(
            "/api/auth/login/finish",
            json={
                "email": email,
                "auth_key_b64": b64(b"\x01" * 32),
            },
        )
        assert r.status_code == 401
        code = pyotp.TOTP(secret).now()
        r = await c.post(
            "/api/auth/login/finish",
            json={
                "email": email,
                "auth_key_b64": b64(b"\x01" * 32),
                "totp_code": code,
            },
        )
        assert r.status_code == 200
