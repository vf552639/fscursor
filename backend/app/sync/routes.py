from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.blobs.models import BlobStorage
from app.core.database import get_db
from app.models.activity_log import ActivityLog
from app.models.cloudflare_account import CloudflareAccount
from app.models.domain import Domain
from app.models.notification import Notification
from app.models.registrar_account import RegistrarAccount
from app.models.server import Server
from app.models.system_config import SystemConfig
from app.models.task_log import TaskLog
from app.sync import schemas
from app.sync.service import current_version

router = APIRouter(prefix="/sync", tags=["sync"])

SCOPED_MODELS = {
    "domains": Domain,
    "servers": Server,
    "cloudflare_accounts": CloudflareAccount,
    "registrar_accounts": RegistrarAccount,
    "notifications": Notification,
    "task_logs": TaskLog,
    "system_config": SystemConfig,
    "activity_logs": ActivityLog,
}


def _row_id(table: str, obj: object) -> str:
    if table == "system_config":
        return str(getattr(obj, "key"))
    return str(getattr(obj, "id"))


def _to_row(table: str, obj: object) -> schemas.ChangeRow:
    skip = {"sync_version", "sync_deleted", "user_id"}
    fields = None if obj.sync_deleted else {
        c.name: getattr(obj, c.name)
        for c in obj.__table__.columns
        if c.name not in skip
    }
    return schemas.ChangeRow(
        table=table,
        id=_row_id(table, obj),
        version=obj.sync_version,
        deleted=obj.sync_deleted,
        fields=fields,
    )


@router.get("/snapshot", response_model=schemas.SyncSnapshotResponse)
async def snapshot(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> schemas.SyncSnapshotResponse:
    rows: list[schemas.ChangeRow] = []
    for table, model in SCOPED_MODELS.items():
        result = await db.execute(select(model).where(model.user_id == user.id))
        for obj in result.scalars().all():
            rows.append(_to_row(table, obj))
    blob_ids = [
        str(b.id)
        for b in (
            await db.execute(select(BlobStorage).where(BlobStorage.user_id == user.id))
        ).scalars().all()
    ]
    return schemas.SyncSnapshotResponse(
        version=await current_version(db, user.id),
        rows=rows,
        blob_ids=blob_ids,
    )


@router.get("/changes", response_model=schemas.SyncChangesResponse)
async def changes(
    since: int = Query(0, ge=0),
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> schemas.SyncChangesResponse:
    rows: list[schemas.ChangeRow] = []
    for table, model in SCOPED_MODELS.items():
        result = await db.execute(
            select(model).where(model.user_id == user.id, model.sync_version > since)
        )
        for obj in result.scalars().all():
            rows.append(_to_row(table, obj))
    blob_ids = [
        str(b.id)
        for b in (
            await db.execute(
                select(BlobStorage).where(
                    BlobStorage.user_id == user.id, BlobStorage.version > since
                )
            )
        ).scalars().all()
    ]
    return schemas.SyncChangesResponse(
        version=await current_version(db, user.id),
        rows=rows,
        blob_ids=blob_ids,
    )
