from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import Select, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import RENEWAL_NOTICE_MONTHS
from app.models.domain import Domain
from app.models.notification import Notification
from app.services.notification_providers import dispatch_notification


def _base_list_stmt(user_id: UUID, is_read: Optional[bool], limit: int) -> Select[tuple[Notification]]:
    stmt = (
        select(Notification)
        .where(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc())
        .limit(limit)
    )
    if is_read is not None:
        stmt = stmt.where(Notification.is_read == is_read)
    return stmt


async def list_notifications(
    db: AsyncSession,
    user_id: UUID,
    is_read: Optional[bool] = None,
    limit: int = 50,
) -> list[Notification]:
    result = await db.execute(_base_list_stmt(user_id, is_read, limit))
    return list(result.scalars().all())


async def count_unread(db: AsyncSession, user_id: UUID) -> int:
    result = await db.execute(
        select(func.count(Notification.id)).where(
            Notification.user_id == user_id, Notification.is_read.is_(False)
        )
    )
    return int(result.scalar_one() or 0)


async def mark_read(db: AsyncSession, user_id: UUID, ids: list[int]) -> int:
    if not ids:
        return 0
    result = await db.execute(
        update(Notification)
        .where(
            Notification.id.in_(ids),
            Notification.user_id == user_id,
            Notification.is_read.is_(False),
        )
        .values(is_read=True, read_at=datetime.now(timezone.utc))
    )
    await db.commit()
    return int(result.rowcount or 0)


async def mark_all_read(db: AsyncSession, user_id: UUID) -> int:
    result = await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id, Notification.is_read.is_(False))
        .values(is_read=True, read_at=datetime.now(timezone.utc))
    )
    await db.commit()
    return int(result.rowcount or 0)


async def delete_notification(db: AsyncSession, user_id: UUID, notification_id: int) -> bool:
    result = await db.execute(
        delete(Notification).where(
            Notification.id == notification_id, Notification.user_id == user_id
        )
    )
    await db.commit()
    return bool(result.rowcount)


async def upsert_renewal_notification(db: AsyncSession, domain: Domain) -> bool:
    if domain.purchase_date is None or domain.user_id is None:
        return False
    purchase_key = domain.purchase_date.isoformat()
    dedup_key = f"domain_renewal:{domain.id}:{purchase_key}"
    message = (
        f"Domain {domain.domain_name} (purchase date {purchase_key}) "
        f"is at or past the {RENEWAL_NOTICE_MONTHS}-month renewal notice window."
    )

    stmt = (
        insert(Notification)
        .values(
            type="domain_renewal",
            entity_type="domain",
            entity_id=domain.id,
            title=f"Domain {domain.domain_name} needs renewal",
            message=message,
            dedup_key=dedup_key,
            is_read=False,
            user_id=domain.user_id,
        )
        .on_conflict_do_nothing(index_elements=[Notification.dedup_key])
        .returning(Notification.id)
    )
    result = await db.execute(stmt)
    created = result.scalar_one_or_none() is not None
    if created:
        await db.commit()
    return created


async def create_notification(
    db: AsyncSession,
    *,
    user_id: UUID,
    type: str,
    entity_type: str,
    entity_id: int,
    title: str,
    message: str,
    dedup_key: str,
) -> bool:
    stmt = (
        insert(Notification)
        .values(
            type=type,
            entity_type=entity_type,
            entity_id=entity_id,
            title=title,
            message=message,
            dedup_key=dedup_key,
            is_read=False,
            user_id=user_id,
        )
        .on_conflict_do_nothing(index_elements=[Notification.dedup_key])
        .returning(Notification.id)
    )
    result = await db.execute(stmt)
    created = result.scalar_one_or_none() is not None
    if created:
        await db.commit()
        await dispatch_notification(
            db,
            {
                "type": type,
                "entity_type": entity_type,
                "entity_id": entity_id,
                "title": title,
                "message": message,
                "dedup_key": dedup_key,
            },
            user_id,
        )
    return created
