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
