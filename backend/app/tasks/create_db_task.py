import asyncio

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.server import Server, ServerSecret
from app.services.encryption_service import decrypt, encrypt
from app.services.fastpanel_client import create_database, get_fastpanel_path, open_ssh


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
            result = await asyncio.to_thread(
                create_database, client, fp_path, domain.domain_name, domain.db_name, domain.db_user
            )
            if not result.get("success"):
                return {"domain_id": domain_id, "error": result.get("error") or "Create DB failed"}
            domain.db_name = result["db_name"]
            domain.db_user = result["db_user"]
            domain.db_password_encrypted = encrypt(result["db_password"])
            await session.commit()
            return {"domain_id": domain_id, "error": None}
        finally:
            if client is not None:
                await asyncio.to_thread(client.close)


@celery_app.task(name="app.tasks.domain.create_db")
def create_db(domain_id: int) -> dict:
    return asyncio.run(_main(domain_id))
