import asyncio
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.cloudflare_account import CloudflareAccount
from app.models.domain import Domain
from app.models.registrar_account import RegistrarAccount
from app.models.task_log import TaskLog
from app.services import cloudflare_service
from app.services.cloudflare_service import CloudflareError
from app.services.registrars import RegistrarError, get_service


async def _set_ns(domain_id: int, zone_id_override: Optional[str] = None) -> None:
    async with AsyncSessionLocal() as session:
        domain = (
            await session.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one_or_none()
        if not domain:
            return

        task_log = TaskLog(
            entity_type="domain",
            entity_id=domain_id,
            task_type="set_ns",
            status="running",
            log_text="",
        )
        session.add(task_log)
        await session.flush()

        def log(msg: str) -> None:
            task_log.log_text = (task_log.log_text or "") + msg + "\n"

        async def fail(msg: str) -> None:
            log(msg)
            domain.ns_status = "error"
            task_log.status = "failed"
            await session.commit()

        try:
            if not domain.cloudflare_account_id:
                await fail("No Cloudflare account assigned")
                return

            cf_account: Optional[CloudflareAccount] = (
                await session.execute(
                    select(CloudflareAccount).where(
                        CloudflareAccount.id == domain.cloudflare_account_id
                    )
                )
            ).scalar_one_or_none()
            if not cf_account:
                await fail("Cloudflare account not found")
                return

            zone_id = zone_id_override or domain.cloudflare_zone_id
            if not zone_id:
                log("Searching zone by domain name")
                zones = await cloudflare_service.list_zones(
                    session, domain.cloudflare_account_id
                )
                match = next(
                    (z for z in zones if z.get("name") == domain.domain_name), None
                )
                if not match:
                    await fail("Zone not found in Cloudflare")
                    return
                zone_id = match["id"]
                domain.cloudflare_zone_id = zone_id

            ns = await cloudflare_service.get_nameservers(
                session, domain.cloudflare_account_id, zone_id
            )
            if not ns:
                await fail("Cloudflare returned empty nameservers")
                return
            log(f"Cloudflare nameservers: {', '.join(ns)}")

            if not domain.registrar_id:
                domain.ns_status = "pending"
                domain.ns_updated_at = datetime.now(timezone.utc)
                log("No registrar assigned — stored NS, not applied")
                task_log.status = "success"
                await session.commit()
                return

            registrar: Optional[RegistrarAccount] = (
                await session.execute(
                    select(RegistrarAccount).where(
                        RegistrarAccount.id == domain.registrar_id
                    )
                )
            ).scalar_one_or_none()
            if not registrar:
                await fail("Registrar account not found")
                return

            service = get_service(registrar)
            log(f"Applying NS via {service.provider}")
            await service.set_nameservers(domain.domain_name, ns)

            domain.ns_status = "ok"
            domain.ns_updated_at = datetime.now(timezone.utc)
            log("Nameservers applied")
            task_log.status = "success"
        except CloudflareError as e:
            await fail(f"Cloudflare error: {e}")
            return
        except RegistrarError as e:
            await fail(f"Registrar error: {e}")
            return
        except Exception as e:
            await fail(f"Error: {type(e).__name__}: {e}")
            return

        await session.commit()


@celery_app.task(name="app.tasks.ns.set_nameservers")
def set_nameservers(domain_id: int, cloudflare_zone_id: Optional[str] = None) -> dict:
    asyncio.run(_set_ns(domain_id, cloudflare_zone_id))
    return {"domain_id": domain_id}
