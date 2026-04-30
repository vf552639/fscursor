import asyncio

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.constants import SslStatus
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.server import Server, ServerSecret
from app.services.encryption_service import decrypt
from app.services.fastpanel_client import open_ssh, read_ssl_info_via_ssh


async def _refresh_one(session, domain: Domain) -> None:
    if not domain.server_id:
        return
    server = await session.get(Server, domain.server_id)
    secret = (
        await session.execute(select(ServerSecret).where(ServerSecret.server_id == domain.server_id))
    ).scalar_one_or_none()
    if server is None or secret is None or not secret.ssh_password_encrypted:
        return
    client = None
    try:
        ssh_password = decrypt(secret.ssh_password_encrypted)
        client = await asyncio.to_thread(open_ssh, server.ip_address, server.ssh_port, server.ssh_user, ssh_password)
        info = await asyncio.to_thread(read_ssl_info_via_ssh, client, domain.domain_name)
        if info.get("has_certificate"):
            domain.ssl_status = SslStatus.ACTIVE.value
            domain.ssl_expires_at = info.get("expires_at")
            domain.ssl_issuer = info.get("issuer")
        else:
            domain.ssl_status = SslStatus.NONE.value
            domain.ssl_expires_at = None
            domain.ssl_issuer = None
    finally:
        if client is not None:
            await asyncio.to_thread(client.close)


async def _refresh_domain_ssl(domain_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        domain = (await session.execute(select(Domain).where(Domain.id == domain_id))).scalar_one_or_none()
        if not domain:
            return {"domain_id": domain_id, "error": "Domain not found"}
        await _refresh_one(session, domain)
        await session.commit()
        return {"domain_id": domain_id, "error": None}


async def _refresh_all() -> dict:
    async with AsyncSessionLocal() as session:
        domains = (
            await session.execute(select(Domain).where(Domain.server_id.is_not(None)))
        ).scalars().all()
        for domain in domains:
            await _refresh_one(session, domain)
        await session.commit()
        return {"total": len(domains)}


@celery_app.task(name="app.tasks.domain.refresh_ssl")
def refresh_domain_ssl(domain_id: int) -> dict:
    return asyncio.run(_refresh_domain_ssl(domain_id))


@celery_app.task(name="app.tasks.domain.refresh_ssl_all")
def refresh_ssl_status_all() -> dict:
    return asyncio.run(_refresh_all())
