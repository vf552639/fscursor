from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.services import system_config_service
from app.services.notification_providers.telegram import send_telegram_message
from app.services.notification_providers.webhook import send_webhook


def _is_enabled(value: str | None) -> bool:
    if not value:
        return False
    return value.strip().lower() in {"1", "true", "yes", "on", "enabled"}


async def _get_config_value(db: AsyncSession, key: str) -> str | None:
    item = await system_config_service.get(db, key)
    if item is None:
        return None
    return item.value


async def deliver_to_channels(db: AsyncSession, payload: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    webhook_enabled = _is_enabled(await _get_config_value(db, "Webhook Enabled"))
    webhook_url = await _get_config_value(db, "Webhook URL")
    webhook_secret = await _get_config_value(db, "Webhook Secret")
    if webhook_enabled and webhook_url:
        ok, msg = await send_webhook(url=webhook_url, secret=webhook_secret, payload=payload)
        result["webhook"] = "ok" if ok else f"error: {msg}"
    else:
        result["webhook"] = "disabled"

    telegram_enabled = _is_enabled(await _get_config_value(db, "Telegram Enabled"))
    if telegram_enabled and settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_CHAT_ID:
        text = f"[{payload.get('type', 'notification')}] {payload.get('title', '')}\n{payload.get('message', '')}"
        ok, msg = await send_telegram_message(
            bot_token=settings.TELEGRAM_BOT_TOKEN,
            chat_id=settings.TELEGRAM_CHAT_ID,
            text=text.strip(),
        )
        result["telegram"] = "ok" if ok else f"error: {msg}"
    else:
        result["telegram"] = "disabled"
    return result


async def dispatch_notification(db: AsyncSession, payload: dict[str, Any]) -> None:
    await deliver_to_channels(db, payload)
