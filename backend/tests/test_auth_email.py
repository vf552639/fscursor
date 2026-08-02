import pytest
from loguru import logger as loguru_logger

from app.auth.email import send_confirmation_email
from app.core.config import settings


@pytest.mark.asyncio
async def test_send_falls_back_to_log_in_dev(monkeypatch):
    # В dev-режиме (нет RESEND_API_KEY) письмо не уходит по HTTP, а логируется.
    # logging.py роутит логгер "app" в loguru с propagate=False, поэтому pytest
    # caplog его не видит — перехватываем через временный loguru-sink.
    monkeypatch.setattr(settings, "RESEND_API_KEY", None)

    captured: list[str] = []
    sink_id = loguru_logger.add(lambda m: captured.append(str(m)), level="INFO")
    try:
        ok = await send_confirmation_email("u@example.com", "tok123")
    finally:
        loguru_logger.remove(sink_id)

    assert ok
    assert any("u@example.com" in line for line in captured)
