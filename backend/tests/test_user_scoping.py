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


async def _register_and_login(client: AsyncClient, email: str, key: bytes = b"\x01" * 32) -> None:
    from datetime import datetime, timezone

    await client.post(
        "/api/auth/register",
        json={
            "email": email,
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(key),
            "recovery_blob_b64": b64(b"\x02" * 96),
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
async def test_user_a_cannot_see_user_b_domains():
    dom = f"{uuid.uuid4().hex[:8]}.example.com"
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, f"a-{uuid.uuid4().hex[:8]}@example.com")
        r = await c.post("/api/domains", json={"domain_name": dom})
        assert r.status_code == 201
        a_domain_id = r.json()["id"]
        await c.post("/api/auth/logout")
        await _register_and_login(c, f"b-{uuid.uuid4().hex[:8]}@example.com", key=b"\x99" * 32)
        r = await c.get("/api/domains")
        assert r.status_code == 200
        for item in r.json():
            assert item["id"] != a_domain_id
        r = await c.get(f"/api/domains/{a_domain_id}")
        assert r.status_code == 404
