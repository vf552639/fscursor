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


async def _login(client: AsyncClient, email: str) -> None:
    from datetime import datetime, timezone

    await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
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
        json={"email": email, "auth_key_b64": b64(b"\x01" * 32)},
    )


@pytest.mark.asyncio
async def test_sync_snapshot_includes_domain():
    email = f"sync-{uuid.uuid4().hex[:8]}@example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _login(c, email)
        r = await c.get("/api/sync/snapshot")
        assert r.status_code == 200
        assert r.json()["rows"] == []

        r = await c.post(
            "/api/domains",
            json={"domain_name": f"{uuid.uuid4().hex[:8]}.example.com"},
        )
        assert r.status_code == 201
        r = await c.get("/api/sync/snapshot")
        assert r.status_code == 200
        rows = r.json()["rows"]
        assert any(row["table"] == "domains" for row in rows)
