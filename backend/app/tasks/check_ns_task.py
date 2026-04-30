import asyncio
from datetime import datetime, timezone

from dns import resolver
from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.registrar_account import RegistrarAccount
from app.services import cloudflare_service
from app.services.registrars import get_service


def _normalize_ns(items: list[str]) -> list[str]:
    return sorted({str(x).strip().lower().rstrip(".") for x in items if str(x).strip()})


async def _main(domain_id: int) -> dict:
    async with AsyncSessionLocal() as session:
        domain = (await session.execute(select(Domain).where(Domain.id == domain_id))).scalar_one_or_none()
        if not domain:
            return {"domain_id": domain_id, "error": "Domain not found"}
        if not domain.cloudflare_account_id or not domain.cloudflare_zone_id:
            return {"domain_id": domain_id, "error": "Cloudflare account/zone is not assigned"}

        cf_ns = _normalize_ns(
            await cloudflare_service.get_nameservers(
                session,
                domain.cloudflare_account_id,
                domain.cloudflare_zone_id,
            )
        )
        if not cf_ns:
            return {"domain_id": domain_id, "error": "Cloudflare nameservers are empty"}

        current_ns: list[str] = []
        if domain.registrar_id:
            registrar = (
                await session.execute(
                    select(RegistrarAccount).where(RegistrarAccount.id == domain.registrar_id)
                )
            ).scalar_one_or_none()
            if registrar:
                service = get_service(registrar)
                try:
                    current_ns = _normalize_ns(await service.get_nameservers(domain.domain_name))
                except NotImplementedError:
                    current_ns = []
        if not current_ns:
            answers = await asyncio.to_thread(resolver.resolve, domain.domain_name, "NS")
            current_ns = _normalize_ns([str(r.target) for r in answers])

        domain.ns_status = "ok" if set(current_ns) == set(cf_ns) else "error"
        domain.ns_check_mode = "auto"
        domain.ns_updated_at = datetime.now(timezone.utc)
        await session.commit()
        return {"domain_id": domain_id, "error": None, "current_ns": current_ns, "cf_ns": cf_ns}


@celery_app.task(name="app.tasks.domain.check_ns")
def check_ns(domain_id: int) -> dict:
    return asyncio.run(_main(domain_id))
