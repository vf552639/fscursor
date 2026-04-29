from urllib.parse import quote_plus

import httpx


async def send_telegram_message(
    *,
    bot_token: str,
    chat_id: str,
    text: str,
) -> tuple[bool, str]:
    url = f"https://api.telegram.org/bot{quote_plus(bot_token)}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload)
        if resp.status_code >= 400:
            return False, f"HTTP {resp.status_code}"
        data = resp.json() if resp.content else {}
        if not data.get("ok", False):
            return False, "Telegram API returned non-ok"
        return True, "ok"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
