from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.database import get_db
from app.services.notification_providers.dispatcher import deliver_to_channels
from app.services import system_config_service

router = APIRouter(prefix="/settings", tags=["settings"])


class ConfigUpdate(BaseModel):
    value: str


class ConfigItem(BaseModel):
    key: str
    value: str
    editable: bool = True


class NotificationTestRequest(BaseModel):
    title: str = "SDMP test notification"
    message: str = "This is a test delivery from Settings."


class NotificationTestResponse(BaseModel):
    webhook: str
    telegram: str


@router.get("/config", response_model=list[ConfigItem])
async def list_config(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> list[ConfigItem]:
    items = await system_config_service.get_all(db, user.id)
    return [
        ConfigItem(
            key=item.key,
            value=item.value,
            editable=item.key in system_config_service.EDITABLE_KEYS,
        )
        for item in items
    ]


@router.put("/config/{key}", response_model=ConfigItem)
async def update_config(
    key: str,
    payload: ConfigUpdate,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> ConfigItem:
    if key not in system_config_service.EDITABLE_KEYS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Config key '{key}' is not editable",
        )
    item = await system_config_service.upsert(db, key, payload.value, user.id)
    return ConfigItem(key=item.key, value=item.value, editable=True)


@router.post("/notifications/test", response_model=NotificationTestResponse)
async def test_notification_delivery(
    payload: NotificationTestRequest,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> NotificationTestResponse:
    result = await deliver_to_channels(
        db,
        {
            "type": "settings_test",
            "entity_type": "settings",
            "entity_id": 0,
            "title": payload.title,
            "message": payload.message,
            "dedup_key": "settings_test_delivery",
        },
        user.id,
    )
    return NotificationTestResponse(
        webhook=result.get("webhook", "disabled"),
        telegram=result.get("telegram", "disabled"),
    )
