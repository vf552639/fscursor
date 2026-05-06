from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.cloudflare_account import CloudflareAccount
from app.schemas.cloudflare import (
    CloudflareAccountCreate,
    CloudflareAccountResponse,
    CloudflareAccountUpdate,
)
from app.sync.service import touch_entity_sync


def build_account_response(account: CloudflareAccount) -> CloudflareAccountResponse:
    masked = None
    if account.api_token_blob_id:
        s = str(account.api_token_blob_id)
        masked = "••••" + s[-4:]
    payload = CloudflareAccountResponse.model_validate(account).model_dump()
    payload["api_token_masked"] = masked
    payload["sync_result"] = None
    payload["sync_warning"] = None
    return CloudflareAccountResponse(**payload)


async def _get_account(
    db: AsyncSession, account_id: int, user_id: UUID
) -> Optional[CloudflareAccount]:
    acc = (await db.execute(select(CloudflareAccount).where(CloudflareAccount.id == account_id))).scalar_one_or_none()
    if acc is None or acc.user_id != user_id:
        return None
    return acc


async def list_accounts(db: AsyncSession, user_id: UUID) -> list[CloudflareAccount]:
    result = await db.execute(
        select(CloudflareAccount)
        .where(CloudflareAccount.user_id == user_id)
        .order_by(CloudflareAccount.id.desc())
    )
    return list(result.scalars().all())


async def get_account(
    db: AsyncSession, account_id: int, user_id: UUID
) -> Optional[CloudflareAccount]:
    return await _get_account(db, account_id, user_id)


async def create_account(
    db: AsyncSession, data: CloudflareAccountCreate, user_id: UUID
) -> CloudflareAccount:
    account = CloudflareAccount(
        name=data.name,
        account_id=data.account_id,
        api_token_blob_id=data.api_token_blob_id,
        is_active=data.is_active,
        user_id=user_id,
    )
    await touch_entity_sync(db, user_id, account)
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return account


async def update_account(
    db: AsyncSession, account_id: int, data: CloudflareAccountUpdate, user_id: UUID
) -> Optional[CloudflareAccount]:
    account = await _get_account(db, account_id, user_id)
    if not account:
        return None
    patch = data.model_dump(exclude_unset=True, exclude={"api_token_blob_id"})
    for k, v in patch.items():
        setattr(account, k, v)
    if data.api_token_blob_id is not None:
        account.api_token_blob_id = data.api_token_blob_id
    await touch_entity_sync(db, user_id, account)
    await db.commit()
    await db.refresh(account)
    return account


async def delete_account(db: AsyncSession, account_id: int, user_id: UUID) -> bool:
    account = await _get_account(db, account_id, user_id)
    if not account:
        return False
    await db.delete(account)
    await db.commit()
    return True
