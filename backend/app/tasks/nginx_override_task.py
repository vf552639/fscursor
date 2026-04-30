import asyncio

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.server import Server, ServerSecret
from app.services.encryption_service import decrypt
from app.services.fastpanel_client import apply_nginx_override, get_fastpanel_path, open_ssh


async def _main(domain_id: int, snippet: str, presets: dict | None = None) -> dict:
    async with AsyncSessionLocal() as session:
        domain = (await session.execute(select(Domain).where(Domain.id == domain_id))).scalar_one_or_none()
        if not domain:
            return {"domain_id": domain_id, "error": "Domain not found"}
        if not domain.server_id:
            return {"domain_id": domain_id, "error": "Domain has no assigned server"}
        if not domain.site_user:
            return {"domain_id": domain_id, "error": "Domain has no site user"}
        server = await session.get(Server, domain.server_id)
        secret = (
            await session.execute(select(ServerSecret).where(ServerSecret.server_id == domain.server_id))
        ).scalar_one_or_none()
        if server is None or secret is None or not secret.ssh_password_encrypted:
            return {"domain_id": domain_id, "error": "Server credentials missing"}

        client = None
        try:
            ssh_password = decrypt(secret.ssh_password_encrypted)
            client = await asyncio.to_thread(
                open_ssh, server.ip_address, server.ssh_port, server.ssh_user, ssh_password
            )
            fp_path = await asyncio.to_thread(get_fastpanel_path, client, None)
            if not fp_path:
                return {"domain_id": domain_id, "error": "FastPanel binary not found"}
            result = await asyncio.to_thread(
                apply_nginx_override,
                client,
                fp_path,
                domain.domain_name,
                domain.site_user,
                snippet,
                presets or {},
            )
            if not result.get("success"):
                return {"domain_id": domain_id, "error": result.get("error") or "nginx override failed"}
            domain.nginx_override = result.get("snippet", snippet)
            domain.nginx_presets = presets or {}
            await session.commit()
            return {"domain_id": domain_id, "error": None}
        finally:
            if client is not None:
                await asyncio.to_thread(client.close)


@celery_app.task(name="app.tasks.domain.nginx_override")
def set_nginx_override(domain_id: int, snippet: str, presets: dict | None = None) -> dict:
    return asyncio.run(_main(domain_id, snippet, presets))
