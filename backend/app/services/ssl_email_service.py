from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validators import is_valid_email
from app.models.ssl_email import SslEmail
from app.sync.service import touch_entity_sync


async def add_email(
    db: AsyncSession, email: str, cap: int, user_id: UUID
) -> SslEmail:
    if not is_valid_email(email):
        raise ValueError("Invalid email format")
    item = SslEmail(
        email=email, usage_count=0, usage_cap=cap, is_active=True, user_id=user_id
    )
    await touch_entity_sync(db, user_id, item)
    db.add(item)
    await db.commit()
    await db.refresh(item)
    return item


async def list_emails(db: AsyncSession, user_id: UUID) -> list[SslEmail]:
    result = await db.execute(
        select(SslEmail).where(SslEmail.user_id == user_id).order_by(SslEmail.id.asc())
    )
    return list(result.scalars().all())


async def update_email(
    db: AsyncSession,
    email_id: int,
    user_id: UUID,
    *,
    is_active: bool | None = None,
    usage_cap: int | None = None,
) -> SslEmail | None:
    item = await db.get(SslEmail, email_id)
    if item is None or item.user_id != user_id:
        return None
    if is_active is not None:
        item.is_active = is_active
    if usage_cap is not None:
        item.usage_cap = usage_cap
    await touch_entity_sync(db, user_id, item)
    await db.commit()
    await db.refresh(item)
    return item


async def delete_email(db: AsyncSession, email_id: int, user_id: UUID) -> bool:
    item = await db.get(SslEmail, email_id)
    if item is None or item.user_id != user_id:
        return False
    await db.delete(item)
    await db.commit()
    return True
