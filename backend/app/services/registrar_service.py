from typing import Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.registrar_account import RegistrarAccount
from app.schemas.registrar import RegistrarAccountCreate, RegistrarAccountUpdate
from app.sync.service import touch_entity_sync


async def list_accounts(db: AsyncSession, user_id: UUID) -> list[RegistrarAccount]:
    result = await db.execute(
        select(RegistrarAccount)
        .where(RegistrarAccount.user_id == user_id)
        .order_by(RegistrarAccount.id.desc())
    )
    return list(result.scalars().all())


async def get_account(
    db: AsyncSession, account_id: int, user_id: UUID
) -> Optional[RegistrarAccount]:
    acc = (
        await db.execute(select(RegistrarAccount).where(RegistrarAccount.id == account_id))
    ).scalar_one_or_none()
    if acc is None or acc.user_id != user_id:
        return None
    return acc


async def create_account(
    db: AsyncSession, data: RegistrarAccountCreate, user_id: UUID
) -> RegistrarAccount:
    account = RegistrarAccount(
        provider=data.provider.lower(),
        name=data.name,
        api_user=data.api_user,
        is_active=data.is_active,
        api_key_blob_id=data.api_key_blob_id,
        api_secret_blob_id=data.api_secret_blob_id,
        user_id=user_id,
    )
    await touch_entity_sync(db, user_id, account)
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return account


async def update_account(
    db: AsyncSession, account_id: int, data: RegistrarAccountUpdate, user_id: UUID
) -> Optional[RegistrarAccount]:
    account = await get_account(db, account_id, user_id)
    if not account:
        return None
    patch = data.model_dump(
        exclude_unset=True, exclude={"api_key_blob_id", "api_secret_blob_id"}
    )
    if "provider" in patch and patch["provider"]:
        patch["provider"] = patch["provider"].lower()
    for k, v in patch.items():
        setattr(account, k, v)
    if data.api_key_blob_id is not None:
        account.api_key_blob_id = data.api_key_blob_id
    if data.api_secret_blob_id is not None:
        account.api_secret_blob_id = data.api_secret_blob_id
    await touch_entity_sync(db, user_id, account)
    await db.commit()
    await db.refresh(account)
    return account


async def delete_account(db: AsyncSession, account_id: int, user_id: UUID) -> bool:
    account = await get_account(db, account_id, user_id)
    if not account:
        return False
    await db.delete(account)
    await db.commit()
    return True
