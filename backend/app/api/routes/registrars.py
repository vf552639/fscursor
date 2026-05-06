from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit_service
from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.database import get_db
from app.schemas.registrar import RegistrarAccountCreate, RegistrarAccountResponse, RegistrarAccountUpdate
from app.services import registrar_service

router = APIRouter(prefix="/registrars", tags=["registrars"])


@router.get("/accounts", response_model=list[RegistrarAccountResponse])
async def list_accounts(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    items = await registrar_service.list_accounts(db, user.id)
    return [RegistrarAccountResponse.model_validate(a) for a in items]


@router.post(
    "/accounts",
    response_model=RegistrarAccountResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_account(
    data: RegistrarAccountCreate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    account = await registrar_service.create_account(db, data, user.id)
    await audit_service.log(
        db,
        user_id=user.id,
        action="registrar.account.create",
        target_type="registrar_account",
        target_id=str(account.id),
    )
    await db.commit()
    return RegistrarAccountResponse.model_validate(account)


@router.put("/accounts/{account_id}", response_model=RegistrarAccountResponse)
async def update_account(
    account_id: int,
    data: RegistrarAccountUpdate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    account = await registrar_service.update_account(db, account_id, data, user.id)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="registrar.account.update",
        target_type="registrar_account",
        target_id=str(account_id),
    )
    await db.commit()
    return RegistrarAccountResponse.model_validate(account)


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: int,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
):
    ok = await registrar_service.delete_account(db, account_id, user.id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    await audit_service.log(
        db,
        user_id=user.id,
        action="registrar.account.delete",
        target_type="registrar_account",
        target_id=str(account_id),
    )
    await db.commit()
