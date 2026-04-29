import httpx

from app.core.config import settings


RAPIDAPI_HOST = "temporary-gmail-account.p.rapidapi.com"
RAPIDAPI_URL = f"https://{RAPIDAPI_HOST}/"


async def get_temp_email() -> str | None:
    if not settings.RAPIDAPI_KEY:
        return None
    headers = {
        "x-rapidapi-key": settings.RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
    }
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(RAPIDAPI_URL, headers=headers)
        if resp.status_code >= 400:
            return None
        data = resp.json() if resp.content else {}
        return data.get("address")
    except Exception:
        return None
