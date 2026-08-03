from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.database import get_db
from app.services.notification_providers.dispatcher import deliver_to_channels
from app.services import system_config_service
from app.audit import service as audit_service

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
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> ConfigItem:
    if key not in system_config_service.EDITABLE_KEYS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Config key '{key}' is not editable",
        )
    try:
        item = await system_config_service.upsert(db, key, payload.value, user.id)
    except system_config_service.ConfigOwnershipError:
        # Строка `system_config` одна на ключ на всю установку. Если её уже
        # занял другой пользователь — отказываем, а не переписываем значение
        # и не переприсваиваем владельца (иначе можно было бы, например,
        # перенаправить чужой Webhook URL на себя).
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Config key '{key}' belongs to another user",
        )
    await audit_service.log(
        db,
        user_id=user.id,
        action="settings.config_update",
        target_type="settings",
        target_id=key,
        ip=request.client.host if request.client else None,
        metadata={"key": key},
    )
    await db.commit()
    return ConfigItem(key=item.key, value=item.value, editable=True)


def _coarse_delivery_status(value: str) -> str:
    """Collapse a channel delivery result into a non-sensitive status label.

    `deliver_to_channels` results can be "ok", "disabled", or an "error: ..."
    string that embeds exception text (which may include hostnames or other
    transport details). Only the coarse outcome is safe to persist in audit
    metadata.
    """
    if value in ("ok", "disabled"):
        return value
    return "error"


@router.post("/notifications/test", response_model=NotificationTestResponse)
async def test_notification_delivery(
    payload: NotificationTestRequest,
    request: Request,
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
    await audit_service.log(
        db,
        user_id=user.id,
        action="settings.notification_test",
        target_type="settings",
        ip=request.client.host if request.client else None,
        metadata={
            "webhook": _coarse_delivery_status(result.get("webhook", "disabled")),
            "telegram": _coarse_delivery_status(result.get("telegram", "disabled")),
        },
    )
    await db.commit()
    return NotificationTestResponse(
        webhook=result.get("webhook", "disabled"),
        telegram=result.get("telegram", "disabled"),
    )
