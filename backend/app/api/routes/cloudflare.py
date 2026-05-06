from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit_service
from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.database import get_db
from app.schemas.cloudflare import (
    CloudflareAccountCreate,
    CloudflareAccountResponse,
    CloudflareAccountUpdate,
)
from app.services import cloudflare_service

router = APIRouter(prefix="/cloudflare", tags=["cloudflare"])


@router.get("/accounts", response_model=list[CloudflareAccountResponse])
async def list_accounts(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    items = await cloudflare_service.list_accounts(db, user.id)
    return [cloudflare_service.build_account_response(a) for a in items]


@router.post(
    "/accounts",
    response_model=CloudflareAccountResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_account(
    data: CloudflareAccountCreate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    account = await cloudflare_service.create_account(db, data, user.id)
    await audit_service.log(
        db,
        user_id=user.id,
        action="cf.account.create",
        target_type="cloudflare_account",
        target_id=str(account.id),
    )
    await db.commit()
    return cloudflare_service.build_account_response(account)


@router.put("/accounts/{account_id}", response_model=CloudflareAccountResponse)
async def update_account(
    account_id: int,
    data: CloudflareAccountUpdate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    account = await cloudflare_service.update_account(db, account_id, data, user.id)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="cf.account.update",
        target_type="cloudflare_account",
        target_id=str(account_id),
    )
    await db.commit()
    return cloudflare_service.build_account_response(account)


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: int,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    ok = await cloudflare_service.delete_account(db, account_id, user.id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="cf.account.delete",
        target_type="cloudflare_account",
        target_id=str(account_id),
    )
    await db.commit()
