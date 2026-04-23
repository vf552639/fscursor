from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.registrar import (
    RegistrarAccountCreate,
    RegistrarAccountResponse,
    RegistrarAccountUpdate,
    RegistrarDomain,
    RegistrarTestResponse,
)
from app.services import registrar_service
from app.services.registrars import RegistrarError, get_service

router = APIRouter(prefix="/registrars", tags=["registrars"])


@router.get("/accounts", response_model=list[RegistrarAccountResponse])
async def list_accounts(db: AsyncSession = Depends(get_db)):
    items = await registrar_service.list_accounts(db)
    return [RegistrarAccountResponse.model_validate(a) for a in items]


@router.post(
    "/accounts",
    response_model=RegistrarAccountResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_account(
    data: RegistrarAccountCreate, db: AsyncSession = Depends(get_db)
):
    account = await registrar_service.create_account(db, data)
    return RegistrarAccountResponse.model_validate(account)


@router.put("/accounts/{account_id}", response_model=RegistrarAccountResponse)
async def update_account(
    account_id: int,
    data: RegistrarAccountUpdate,
    db: AsyncSession = Depends(get_db),
):
    account = await registrar_service.update_account(db, account_id, data)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    return RegistrarAccountResponse.model_validate(account)


@router.delete("/accounts/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(account_id: int, db: AsyncSession = Depends(get_db)):
    ok = await registrar_service.delete_account(db, account_id)
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")


@router.post("/accounts/{account_id}/test", response_model=RegistrarTestResponse)
async def test_account(account_id: int, db: AsyncSession = Depends(get_db)):
    account = await registrar_service.get_account(db, account_id)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    try:
        service = get_service(account)
    except RegistrarError as e:
        return RegistrarTestResponse(success=False, message=str(e))
    ok, msg = await service.test_connection()
    return RegistrarTestResponse(success=ok, message=msg)


@router.get(
    "/accounts/{account_id}/domains", response_model=list[RegistrarDomain]
)
async def list_registrar_domains(
    account_id: int, db: AsyncSession = Depends(get_db)
):
    account = await registrar_service.get_account(db, account_id)
    if not account:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Account not found")
    try:
        service = get_service(account)
        items = await service.get_domains()
    except RegistrarError as e:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(e))
    return [RegistrarDomain(**item) for item in items]
