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
async def test_audit_lists_login_and_domain_create():
    email = f"audit-{uuid.uuid4().hex[:8]}@example.com"
    from datetime import datetime, timezone

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await c.post(
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
        await c.post(
            "/api/auth/login/finish",
            json={"email": email, "auth_key_b64": b64(b"\x01" * 32)},
        )
        r = await c.post(
            "/api/domains",
            json={"domain_name": f"{uuid.uuid4().hex[:8]}.example.com"},
        )
        assert r.status_code == 201
        r = await c.get("/api/audit/log")
        assert r.status_code == 200
        actions = {row["action"] for row in r.json()}
        assert "auth.login" in actions
        assert "domain.create" in actions
        for row in r.json():
            meta = row.get("metadata") or {}
            for k in meta:
                assert "password" not in k.lower()
                assert "token" not in k.lower()
