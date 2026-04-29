import hashlib
import hmac
import json
from typing import Any

import httpx


async def send_webhook(
    *,
    url: str,
    secret: str | None,
    payload: dict[str, Any],
) -> tuple[bool, str]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if secret:
        signature = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
        headers["X-SDMP-Signature"] = f"sha256={signature}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, content=body, headers=headers)
        if resp.status_code >= 400:
            return False, f"HTTP {resp.status_code}"
        return True, "ok"
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
