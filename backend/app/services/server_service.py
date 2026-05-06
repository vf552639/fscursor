from typing import Optional
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import FastPanelStatus, ServerStatus
from app.models.server import Server
from app.schemas.server import ServerCreate, ServerUpdate
from app.sync.service import touch_entity_sync


async def get_all(db: AsyncSession, user_id: UUID) -> tuple[list[Server], int]:
    result = await db.execute(
        select(Server).where(Server.user_id == user_id).order_by(Server.id.desc())
    )
    items = list(result.scalars().all())
    total = (
        await db.execute(select(func.count(Server.id)).where(Server.user_id == user_id))
    ).scalar_one()
    return items, int(total)


async def get_by_id(db: AsyncSession, server_id: int, user_id: UUID) -> Optional[Server]:
    server = (await db.execute(select(Server).where(Server.id == server_id))).scalar_one_or_none()
    if server is None or server.user_id != user_id:
        return None
    return server


async def create(db: AsyncSession, data: ServerCreate, user_id: UUID) -> Server:
    payload = data.model_dump(
        exclude={"ssh_password_blob_id", "fastpanel_password_blob_id"},
    )
    server = Server(**payload, user_id=user_id)
    if data.fastpanel_status == FastPanelStatus.INSTALLED.value:
        server.status = ServerStatus.ACTIVE.value
    server.ssh_password_blob_id = data.ssh_password_blob_id
    server.fastpanel_password_blob_id = data.fastpanel_password_blob_id
    await touch_entity_sync(db, user_id, server)
    db.add(server)
    await db.commit()
    await db.refresh(server)
    return server


async def update(
    db: AsyncSession, server_id: int, data: ServerUpdate, user_id: UUID
) -> Optional[Server]:
    server = await get_by_id(db, server_id, user_id)
    if not server:
        return None

    patch = data.model_dump(
        exclude_unset=True,
        exclude={"ssh_password_blob_id", "fastpanel_password_blob_id"},
    )
    for k, v in patch.items():
        setattr(server, k, v)

    if data.ssh_password_blob_id is not None:
        server.ssh_password_blob_id = data.ssh_password_blob_id
    if data.fastpanel_password_blob_id is not None:
        server.fastpanel_password_blob_id = data.fastpanel_password_blob_id

    await touch_entity_sync(db, user_id, server)
    await db.commit()
    await db.refresh(server)
    return server


async def delete(db: AsyncSession, server_id: int, user_id: UUID) -> bool:
    server = await get_by_id(db, server_id, user_id)
    if not server:
        return False
    await db.delete(server)
    await db.commit()
    return True
