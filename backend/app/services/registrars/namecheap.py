import xml.etree.ElementTree as ET

import httpx

from app.services.encryption_service import decrypt
from app.services.registrars.base import BaseRegistrarService, RegistrarError

NAMECHEAP_API = "https://api.namecheap.com/xml.response"
NS_XMLNS = "http://api.namecheap.com/xml.response"


def _split(domain: str) -> tuple[str, str]:
    parts = domain.strip(".").split(".", 1)
    if len(parts) != 2:
        raise RegistrarError(f"Invalid domain: {domain}")
    return parts[0], parts[1]


def _strip_ns(tag: str) -> str:
    return tag.split("}", 1)[-1] if "}" in tag else tag


class NamecheapService(BaseRegistrarService):
    provider = "namecheap"

    def _base_params(self, command: str) -> dict[str, str]:
        if not self.account.api_key_encrypted:
            raise RegistrarError("API key is not set")
        if not self.account.api_user:
            raise RegistrarError("ApiUser is not set")
        api_key = decrypt(self.account.api_key_encrypted)
        client_ip = decrypt(self.account.api_secret_encrypted) if self.account.api_secret_encrypted else "127.0.0.1"
        return {
            "ApiUser": self.account.api_user,
            "ApiKey": api_key,
            "UserName": self.account.api_user,
            "ClientIp": client_ip,
            "Command": command,
        }

    async def _call(self, command: str, extra: dict[str, str]) -> ET.Element:
        params = {**self._base_params(command), **extra}
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(NAMECHEAP_API, params=params)
        if resp.status_code >= 400:
            raise RegistrarError(f"Namecheap HTTP {resp.status_code}: {resp.text}")
        root = ET.fromstring(resp.text)
        status = root.attrib.get("Status", "").lower()
        if status != "ok":
            errors = [e.text or "" for e in root.iter() if _strip_ns(e.tag) == "Error"]
            raise RegistrarError(f"Namecheap error: {'; '.join(errors) or resp.text}")
        return root

    async def test_connection(self) -> tuple[bool, str]:
        try:
            await self._call("namecheap.domains.getList", {"PageSize": "10"})
            return True, "ok"
        except RegistrarError as e:
            return False, str(e)
        except Exception as e:
            return False, f"{type(e).__name__}: {e}"

    async def get_domains(self) -> list[dict]:
        root = await self._call("namecheap.domains.getList", {"PageSize": "100"})
        items: list[dict] = []
        for el in root.iter():
            if _strip_ns(el.tag) == "Domain":
                items.append(
                    {
                        "domain": el.attrib.get("Name"),
                        "expiry_date": el.attrib.get("Expires"),
                        "status": "active" if el.attrib.get("IsExpired") == "false" else "expired",
                        "auto_renew": el.attrib.get("AutoRenew"),
                    }
                )
        return items

    async def set_nameservers(self, domain: str, ns_list: list[str]) -> bool:
        sld, tld = _split(domain)
        root = await self._call(
            "namecheap.domains.dns.setCustom",
            {"SLD": sld, "TLD": tld, "Nameservers": ",".join(ns_list)},
        )
        cmd = root.find(f".//{{{NS_XMLNS}}}CommandResponse")
        if cmd is not None and cmd.attrib.get("Status", "").lower() != "ok":
            errors = [e.text or "" for e in root.iter() if _strip_ns(e.tag) == "Error"]
            raise RegistrarError(f"Namecheap setCustom failed: {'; '.join(errors) or 'unknown error'}")
        return True
