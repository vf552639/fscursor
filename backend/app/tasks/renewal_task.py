import asyncio
from datetime import date

from dateutil.relativedelta import relativedelta
from sqlalchemy import select

from app.core.constants import RENEWAL_NOTICE_MONTHS
from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.task_log import TaskLog
from app.services import notification_service


async def _check_renewals() -> dict[str, int]:
    threshold = date.today() - relativedelta(months=RENEWAL_NOTICE_MONTHS)
    created_count = 0
    checked_count = 0

    async with AsyncSessionLocal() as session:
        domains = (
            await session.execute(
                select(Domain).where(
                    Domain.user_id.isnot(None),
                    Domain.purchase_date.isnot(None),
                    Domain.purchase_date <= threshold,
                )
            )
        ).scalars().all()

        checked_count = len(domains)
        for domain in domains:
            created = await notification_service.upsert_renewal_notification(session, domain)
            if created:
                created_count += 1

        session.add(
            TaskLog(
                entity_type="system",
                entity_id=None,
                task_type="renewal_check",
                status="success",
                log_text=f"created {created_count} reminders (checked {checked_count} domains)",
                user_id=None,
            )
        )
        await session.commit()

    return {"checked": checked_count, "created": created_count}


@celery_app.task(name="app.tasks.renewal.check_domain_renewals")
def check_domain_renewals() -> dict[str, int]:
    return asyncio.run(_check_renewals())
