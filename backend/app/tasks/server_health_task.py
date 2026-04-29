import asyncio

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.server import Server, ServerSecret
from app.services import server_service


async def _check_uptime(server_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        server = await server_service.fetch_and_persist_uptime(session, server_id)
        if not server:
            return {"server_id": server_id, "ok": False, "error": "Server not found"}
        return {
            "server_id": server_id,
            "ok": server.last_check_ok,
            "uptime_seconds": server.uptime_seconds,
            "last_check_error": server.last_check_error,
        }


async def _enqueue_all_servers_uptime() -> dict:
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Server.id)
            .join(ServerSecret, ServerSecret.server_id == Server.id)
            .where(ServerSecret.ssh_password_encrypted.is_not(None))
        )
        ids = [row[0] for row in result.all()]

    for server_id in ids:
        check_server_uptime.delay(server_id)

    return {"queued": len(ids)}


@celery_app.task(name="app.tasks.server_health.check_server_uptime")
def check_server_uptime(server_id: int) -> dict:
    return asyncio.run(_check_uptime(server_id))


@celery_app.task(name="app.tasks.server_health.check_all_servers_uptime")
def check_all_servers_uptime() -> dict:
    return asyncio.run(_enqueue_all_servers_uptime())
