import logging

import pytest

from app.auth.email import send_confirmation_email
from app.core.config import settings


@pytest.mark.asyncio
async def test_send_falls_back_to_log_in_dev(monkeypatch, caplog):
    monkeypatch.setattr(settings, "RESEND_API_KEY", None)
    caplog.set_level(logging.INFO)
    ok = await send_confirmation_email("u@example.com", "tok123")
    assert ok
    assert any("u@example.com" in r.message for r in caplog.records)
