import asyncio

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.constants import SslStatus
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.server import Server, ServerSecret
from app.services.encryption_service import decrypt
from app.services.fastpanel_client import get_fastpanel_path, open_ssh, revoke_ssl_certificate


async def _main(domain_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        domain = (await session.execute(select(Domain).where(Domain.id == domain_id))).scalar_one_or_none()
        if not domain:
            return {"domain_id": domain_id, "error": "Domain not found"}
        if not domain.server_id:
            return {"domain_id": domain_id, "error": "Domain has no assigned server"}
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
            result = await asyncio.to_thread(revoke_ssl_certificate, client, fp_path, domain.domain_name)
            if not result.get("success"):
                return {"domain_id": domain_id, "error": result.get("error") or "SSL cancel failed"}
            domain.ssl_status = SslStatus.NONE.value
            domain.ssl_email_used = None
            domain.ssl_expires_at = None
            domain.ssl_issuer = None
            await session.commit()
            return {"domain_id": domain_id, "error": None}
        finally:
            if client is not None:
                await asyncio.to_thread(client.close)


@celery_app.task(name="app.tasks.domain.revoke_ssl")
def revoke_ssl(domain_id: int) -> dict:
    return asyncio.run(_main(domain_id))
