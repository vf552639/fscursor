import base64

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_login_finish_rate_limited():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        last = None
        for _ in range(11):
            last = await c.post(
                "/api/auth/login/finish",
                json={
                    "email": "nobody@example.com",
                    "auth_key_b64": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
                },
            )
        assert last is not None
        assert last.status_code == 429


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


@pytest.mark.asyncio
async def test_recovery_finish_rate_limited():
    """Перебор recovery-ключа — не менее дорогой путь, чем перебор пароля."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        last = None
        for _ in range(6):
            last = await c.post(
                "/api/auth/recovery/finish",
                json={
                    "email": "nobody@example.com",
                    "recovery_auth_key_b64": _b64(b"\x03" * 32),
                    "new_salt_b64": _b64(b"\x10" * 16),
                    "new_auth_key_b64": _b64(b"\x11" * 32),
                    "new_recovery_blob_b64": _b64(b"\x12" * 96),
                },
            )
        assert last is not None
        assert last.status_code == 429


@pytest.mark.asyncio
async def test_recovery_start_rate_limited():
    """recovery/start — неаутентифицированная выдача salt и блоба."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        last = None
        for _ in range(11):
            last = await c.post("/api/auth/recovery/start", json={"email": "nobody@example.com"})
        assert last is not None
        assert last.status_code == 429
