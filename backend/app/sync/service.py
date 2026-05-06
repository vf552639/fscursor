import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import SyncState


async def bump_version(db: AsyncSession, user_id: uuid.UUID) -> int:
    result = await db.execute(
        select(SyncState).where(SyncState.user_id == user_id).with_for_update()
    )
    state = result.scalar_one_or_none()
    if state is None:
        state = SyncState(user_id=user_id, current_version=1)
        db.add(state)
        await db.flush()
        return 1
    state.current_version += 1
    await db.flush()
    return state.current_version


async def current_version(db: AsyncSession, user_id: uuid.UUID) -> int:
    state = await db.get(SyncState, user_id)
    return state.current_version if state else 0


async def touch_entity_sync(db: AsyncSession, user_id: uuid.UUID, entity: object) -> None:
    entity.sync_version = await bump_version(db, user_id)
