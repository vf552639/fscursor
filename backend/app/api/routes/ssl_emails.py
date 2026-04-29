from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.ssl_email import SslEmailCreate, SslEmailResponse, SslEmailUpdate
from app.services import ssl_email_service

router = APIRouter(prefix="/ssl-emails", tags=["ssl-emails"])


@router.get("", response_model=list[SslEmailResponse])
async def list_ssl_emails(db: AsyncSession = Depends(get_db)) -> list[SslEmailResponse]:
    items = await ssl_email_service.list_emails(db)
    return [SslEmailResponse.model_validate(x) for x in items]


@router.post("", response_model=SslEmailResponse, status_code=status.HTTP_201_CREATED)
async def create_ssl_email(
    data: SslEmailCreate, db: AsyncSession = Depends(get_db)
) -> SslEmailResponse:
    try:
        item = await ssl_email_service.add_email(db, data.email, data.usage_cap)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return SslEmailResponse.model_validate(item)


@router.patch("/{email_id}", response_model=SslEmailResponse)
async def patch_ssl_email(
    email_id: int, data: SslEmailUpdate, db: AsyncSession = Depends(get_db)
) -> SslEmailResponse:
    item = await ssl_email_service.update_email(
        db, email_id, is_active=data.is_active, usage_cap=data.usage_cap
    )
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SSL email not found")
    return SslEmailResponse.model_validate(item)


@router.delete("/{email_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_ssl_email(email_id: int, db: AsyncSession = Depends(get_db)) -> None:
    deleted = await ssl_email_service.delete_email(db, email_id)
    if not deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "SSL email not found")
