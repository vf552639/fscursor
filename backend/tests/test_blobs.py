import base64
import uuid as uuid_mod

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import update

from app.auth.models import User
from app.core.database import AsyncSessionLocal
from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


async def _register_confirm_login(client: AsyncClient, email: str) -> None:
    from datetime import datetime, timezone

    await client.post(
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
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(User)
            .where(User.email == email)
            .values(email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None)
        )
        await s.commit()
    await client.post(
        "/api/auth/login/finish",
        json={"email": email, "auth_key_b64": b64(b"\x01" * 32)},
    )


@pytest.mark.asyncio
async def test_blob_ownership_enforced():
    bid = str(uuid_mod.uuid4())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"blob-a-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.put(
            f"/api/blobs/{bid}",
            json={"blob_kind": "test", "ciphertext_b64": b64(b"secret")},
        )
        assert r.status_code == 200
        r = await c.get(f"/api/blobs/{bid}")
        assert r.status_code == 200

        await c.post("/api/auth/logout")
        await _register_confirm_login(c, f"blob-b-{uuid_mod.uuid4().hex[:8]}@example.com")
        r = await c.get(f"/api/blobs/{bid}")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_blob_too_large_returns_413():
    bid = str(uuid_mod.uuid4())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_confirm_login(c, f"blob-big-{uuid_mod.uuid4().hex[:8]}@example.com")
        huge = b64(b"x" * (65 * 1024))
        r = await c.put(
            f"/api/blobs/{bid}",
            json={"blob_kind": "x", "ciphertext_b64": huge},
        )
        assert r.status_code == 413
