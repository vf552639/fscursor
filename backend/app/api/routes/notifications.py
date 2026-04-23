from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.notification import (
    NotificationMarkReadRequest,
    NotificationResponse,
    UnreadCountResponse,
)
from app.services import notification_service
from app.tasks.renewal_task import check_domain_renewals

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    is_read: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
) -> list[NotificationResponse]:
    items = await notification_service.list_notifications(db, is_read=is_read, limit=limit)
    return [NotificationResponse.model_validate(item) for item in items]


@router.get("/unread-count", response_model=UnreadCountResponse)
async def unread_count(db: AsyncSession = Depends(get_db)) -> UnreadCountResponse:
    count = await notification_service.count_unread(db)
    return UnreadCountResponse(count=count)


@router.post("/mark-read")
async def mark_read(
    payload: NotificationMarkReadRequest, db: AsyncSession = Depends(get_db)
) -> dict[str, int]:
    updated = (
        await notification_service.mark_all_read(db)
        if not payload.ids
        else await notification_service.mark_read(db, payload.ids)
    )
    return {"updated": updated}


@router.delete("/{notification_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_notification(
    notification_id: int, db: AsyncSession = Depends(get_db)
) -> None:
    await notification_service.delete_notification(db, notification_id)


@router.post("/check-renewals", status_code=status.HTTP_202_ACCEPTED)
async def trigger_check_renewals() -> dict[str, str]:
    task = check_domain_renewals.delay()
    return {"task_id": task.id}
