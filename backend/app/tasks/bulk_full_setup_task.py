import asyncio

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.task_log import TaskLog
from app.services import cloudflare_service
from app.tasks.ns_task import _set_ns


async def _append_log(session, task_log: TaskLog, text: str, status_value: str | None = None) -> None:
    task_log.log_text = (task_log.log_text or "") + text
    if status_value:
        task_log.status = status_value
    await session.commit()


async def _main(
    domain_id: int,
    task_log_id: int,
    server_id: int,
    cloudflare_account_id: int,
    registrar_id: int | None,
) -> dict:
    async with AsyncSessionLocal() as session:
        task_log = await session.get(TaskLog, task_log_id)
        if task_log is None:
            return {"domain_id": domain_id, "error": "TaskLog not found"}

        domain = (await session.execute(select(Domain).where(Domain.id == domain_id))).scalar_one_or_none()
        if domain is None:
            await _append_log(session, task_log, "Domain not found\n", "failed")
            return {"domain_id": domain_id, "error": "Domain not found"}

        try:
            await _append_log(session, task_log, "Assigning server/cloudflare/registrar\n", "running")
            domain.server_id = server_id
            domain.cloudflare_account_id = cloudflare_account_id
            if registrar_id is not None:
                domain.registrar_id = registrar_id
            await session.commit()

            await _append_log(session, task_log, "Creating Cloudflare zone\n")
            zone, _created = await cloudflare_service.create_zone(
                session,
                cloudflare_account_id,
                zone_name=domain.domain_name,
            )
            zone_id = (zone.get("id") or "").strip()
            if not zone_id:
                raise RuntimeError("Cloudflare zone creation returned empty id")
            domain.cloudflare_zone_id = zone_id
            domain.cloudflare_enabled = True
            await session.commit()

            await _append_log(session, task_log, "Applying nameservers\n")
            await _set_ns(domain.id, zone_id)
            await _append_log(session, task_log, "Full setup completed\n", "success")
            return {"domain_id": domain.id, "error": None}
        except Exception as exc:
            await _append_log(session, task_log, f"Error: {type(exc).__name__}: {exc}\n", "failed")
            return {"domain_id": domain.id, "error": f"{type(exc).__name__}: {exc}"}


@celery_app.task(name="app.tasks.domain.bulk_full_setup")
def bulk_full_setup_domain(
    domain_id: int,
    task_log_id: int,
    server_id: int,
    cloudflare_account_id: int,
    registrar_id: int | None = None,
) -> dict:
    return asyncio.run(_main(domain_id, task_log_id, server_id, cloudflare_account_id, registrar_id))
