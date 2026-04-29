from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import is_valid_email
from app.models.ssl_email import SslEmail
from app.services.notification_service import create_notification


async def pick_email(db: AsyncSession) -> Optional[SslEmail]:
    result = await db.execute(
        select(SslEmail)
        .where(SslEmail.is_active.is_(True), SslEmail.usage_count < SslEmail.usage_cap)
        .order_by(SslEmail.usage_count.asc(), SslEmail.id.asc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def mark_used(db: AsyncSession, email_id: int) -> None:
    row = await db.get(SslEmail, email_id)
    if row is None:
        return
    row.usage_count += 1
    if row.usage_count >= row.usage_cap:
        row.is_active = False
    await db.commit()
    await warn_if_low_capacity(db)


async def add_email(db: AsyncSession, email: str, cap: int = 100) -> SslEmail:
    if not is_valid_email(email):
        raise ValueError("Invalid email format")
    item = SslEmail(email=email, usage_count=0, usage_cap=cap, is_active=True)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


async def list_emails(db: AsyncSession) -> list[SslEmail]:
    result = await db.execute(select(SslEmail).order_by(SslEmail.id.asc()))
    return list(result.scalars().all())


async def update_email(
    db: AsyncSession,
    email_id: int,
    *,
    is_active: bool | None = None,
    usage_cap: int | None = None,
) -> SslEmail | None:
    item = await db.get(SslEmail, email_id)
    if item is None:
        return None
    if is_active is not None:
        item.is_active = is_active
    if usage_cap is not None:
        item.usage_cap = usage_cap
    await db.commit()
    await db.refresh(item)
    return item


async def delete_email(db: AsyncSession, email_id: int) -> bool:
    item = await db.get(SslEmail, email_id)
    if item is None:
        return False
    await db.delete(item)
    await db.commit()
    return True


async def warn_if_low_capacity(db: AsyncSession) -> None:
    rows = await list_emails(db)
    capacity_total = 0
    capacity_used = 0
    active_left = 0
    for row in rows:
        if not row.is_active:
            continue
        capacity_total += row.usage_cap
        capacity_used += row.usage_count
        active_left += 1
    if active_left == 0:
        await create_notification(
            db,
            type="ssl_pool_exhausted",
            entity_type="ssl_email_pool",
            entity_id=0,
            title="SSL email pool exhausted",
            message="No active SSL email available. Add a new email in settings.",
            dedup_key="ssl_pool_exhausted:global",
        )
        return
    if capacity_total <= 0:
        return
    free_ratio = (capacity_total - capacity_used) / capacity_total
    if free_ratio < 0.10:
        await create_notification(
            db,
            type="ssl_pool_low_capacity",
            entity_type="ssl_email_pool",
            entity_id=0,
            title="SSL email pool capacity is low",
            message=f"Only {max(capacity_total - capacity_used, 0)} SSL slots left across active emails.",
            dedup_key=f"ssl_pool_low_capacity:{capacity_total}:{capacity_used}",
        )
