import httpx

from app.services.encryption_service import decrypt
from app.services.registrars.base import BaseRegistrarService, RegistrarError

HOSTIQ_API = "https://hostiq.ua/api"


class HostiqService(BaseRegistrarService):
    provider = "hostiq"

    def _headers(self) -> dict[str, str]:
        if not self.account.api_key_encrypted:
            raise RegistrarError("API key is not set")
        token = decrypt(self.account.api_key_encrypted)
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def _call(
        self, method: str, path: str, *, json: dict | None = None
    ) -> dict:
        async with httpx.AsyncClient(base_url=HOSTIQ_API, timeout=30.0) as client:
            resp = await client.request(method, path, json=json, headers=self._headers())
        if resp.status_code >= 400:
            raise RegistrarError(f"Hostiq {resp.status_code}: {resp.text}")
        try:
            return resp.json()
        except ValueError:
            return {}

    async def test_connection(self) -> tuple[bool, str]:
        try:
            await self._call("GET", "/domains")
            return True, "ok"
        except RegistrarError as e:
            return False, str(e)
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"

    async def get_domains(self) -> list[dict]:
        data = await self._call("GET", "/domains")
        items = data.get("data") if isinstance(data, dict) else data
        if not isinstance(items, list):
            return []
        return [
            {
                "domain": d.get("domain") or d.get("name"),
                "expiry_date": d.get("expires_at") or d.get("expiry_date"),
                "status": d.get("status"),
                "nameservers": d.get("nameservers") or [],
            }
            for d in items
        ]

    async def set_nameservers(self, domain: str, ns_list: list[str]) -> bool:
        payload = {"nameservers": ns_list}
        await self._call("PUT", f"/domains/{domain}/nameservers", json=payload)
        return True
