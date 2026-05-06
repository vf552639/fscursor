import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


async def send_confirmation_email(to_email: str, token: str) -> bool:
    confirm_url = f"{settings.EMAIL_CONFIRM_BASE_URL}/confirm-email?token={token}"
    subject = "Confirm your SDMP account"
    body = f"Click to confirm: {confirm_url}\n\nThis link expires in 24 hours."
    return await _send(to_email, subject, body)


async def send_recovery_email(to_email: str, token: str) -> bool:
    recover_url = f"{settings.EMAIL_CONFIRM_BASE_URL}/recover?token={token}"
    subject = "SDMP password recovery"
    body = (
        f"You requested a password recovery. Use this link with your BIP39 phrase:\n{recover_url}\n\n"
        "If you did not request this, ignore."
    )
    return await _send(to_email, subject, body)


async def _send(to_email: str, subject: str, body: str) -> bool:
    if not settings.RESEND_API_KEY:
        logger.info("DEV email (no API key): to=%s subject=%s\n%s", to_email, subject, body)
        return True
    headers = {"Authorization": f"Bearer {settings.RESEND_API_KEY}"}
    payload = {
        "from": settings.EMAIL_FROM,
        "to": [to_email],
        "subject": subject,
        "text": body,
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post("https://api.resend.com/emails", headers=headers, json=payload)
    if resp.status_code >= 400:
        logger.error("resend send failed: %s %s", resp.status_code, resp.text)
        return False
    return True
