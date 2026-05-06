import base64
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.blobs.models import BlobStorage
from app.blobs.schemas import BlobResponse, BlobUpsert
from app.core.database import get_db
from app.sync.service import bump_version

router = APIRouter(prefix="/blobs", tags=["blobs"])

MAX_BLOB_BYTES = 64 * 1024


def _to_response(b: BlobStorage) -> BlobResponse:
    return BlobResponse(
        id=b.id,
        blob_kind=b.blob_kind,
        ciphertext_b64=base64.b64encode(b.ciphertext).decode(),
        version=b.version,
        updated_at=b.updated_at,
        deleted=b.deleted,
    )


@router.put("/{blob_id}", response_model=BlobResponse)
async def upsert_blob(
    blob_id: uuid.UUID,
    body: BlobUpsert,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> BlobResponse:
    raw = base64.b64decode(body.ciphertext_b64.encode())
    if len(raw) > MAX_BLOB_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"blob > {MAX_BLOB_BYTES} bytes",
        )
    existing = await db.get(BlobStorage, blob_id)
    new_version = await bump_version(db, user.id)
    if existing is None:
        b = BlobStorage(
            id=blob_id,
            user_id=user.id,
            ciphertext=raw,
            blob_kind=body.blob_kind,
            version=new_version,
            device_id=body.device_id,
            updated_at=datetime.now(timezone.utc),
            deleted=False,
        )
        db.add(b)
    else:
        if existing.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
        existing.ciphertext = raw
        existing.blob_kind = body.blob_kind
        existing.version = new_version
        existing.device_id = body.device_id
        existing.updated_at = datetime.now(timezone.utc)
        existing.deleted = False
        b = existing
    await db.commit()
    await db.refresh(b)
    return _to_response(b)


@router.get("/{blob_id}", response_model=BlobResponse)
async def get_blob(
    blob_id: uuid.UUID,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> BlobResponse:
    b = await db.get(BlobStorage, blob_id)
    if b is None or b.user_id != user.id or b.deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    return _to_response(b)


@router.delete("/{blob_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_blob(
    blob_id: uuid.UUID,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> None:
    b = await db.get(BlobStorage, blob_id)
    if b is None or b.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    new_version = await bump_version(db, user.id)
    b.deleted = True
    b.version = new_version
    b.updated_at = datetime.now(timezone.utc)
    await db.commit()
