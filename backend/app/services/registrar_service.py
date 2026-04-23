from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.registrar_account import RegistrarAccount
from app.schemas.registrar import RegistrarAccountCreate, RegistrarAccountUpdate
from app.services.encryption_service import encrypt


async def list_accounts(db: AsyncSession) -> list[RegistrarAccount]:
    result = await db.execute(
        select(RegistrarAccount).order_by(RegistrarAccount.id.desc())
    )
    return list(result.scalars().all())


async def get_account(db: AsyncSession, account_id: int) -> Optional[RegistrarAccount]:
    return (
        await db.execute(
            select(RegistrarAccount).where(RegistrarAccount.id == account_id)
        )
    ).scalar_one_or_none()


async def create_account(
    db: AsyncSession, data: RegistrarAccountCreate
) -> RegistrarAccount:
    account = RegistrarAccount(
        provider=data.provider.lower(),
        name=data.name,
        api_user=data.api_user,
        is_active=data.is_active,
        api_key_encrypted=encrypt(data.api_key) if data.api_key else None,
        api_secret_encrypted=encrypt(data.api_secret) if data.api_secret else None,
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    return account


async def update_account(
    db: AsyncSession, account_id: int, data: RegistrarAccountUpdate
) -> Optional[RegistrarAccount]:
    account = await get_account(db, account_id)
    if not account:
        return None
    patch = data.model_dump(exclude_unset=True, exclude={"api_key", "api_secret"})
    if "provider" in patch and patch["provider"]:
        patch["provider"] = patch["provider"].lower()
    for k, v in patch.items():
        setattr(account, k, v)
    if data.api_key is not None:
        account.api_key_encrypted = encrypt(data.api_key)
    if data.api_secret is not None:
        account.api_secret_encrypted = encrypt(data.api_secret)
    await db.commit()
    await db.refresh(account)
    return account


async def delete_account(db: AsyncSession, account_id: int) -> bool:
    account = await get_account(db, account_id)
    if not account:
        return False
    await db.delete(account)
    await db.commit()
    return True
