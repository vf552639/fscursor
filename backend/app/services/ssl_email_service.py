from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ssl_email import SslEmail


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


async def add_email(db: AsyncSession, email: str, cap: int = 100) -> SslEmail:
    item = SslEmail(email=email, usage_count=0, usage_cap=cap, is_active=True)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


async def list_emails(db: AsyncSession) -> list[SslEmail]:
    result = await db.execute(select(SslEmail).order_by(SslEmail.id.asc()))
    return list(result.scalars().all())
