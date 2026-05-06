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
async def test_recovery_changes_master_password():
    from datetime import datetime, timezone

    email = f"rec-{uuid.uuid4().hex[:10]}@example.com"
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

        r = await c.post("/api/auth/recovery/start", json={"email": email})
        assert r.status_code == 200
        r = await c.post(
            "/api/auth/recovery/finish",
            json={
                "email": email,
                "new_salt_b64": b64(b"\x10" * 16),
                "new_auth_key_b64": b64(b"\x11" * 32),
                "new_recovery_blob_b64": b64(b"\x12" * 96),
            },
        )
        assert r.status_code == 200

        r = await c.post(
            "/api/auth/login/finish",
            json={
                "email": email,
                "auth_key_b64": b64(b"\x01" * 32),
            },
        )
        assert r.status_code == 401

        r = await c.post(
            "/api/auth/login/finish",
            json={
                "email": email,
                "auth_key_b64": b64(b"\x11" * 32),
            },
        )
        assert r.status_code == 200
