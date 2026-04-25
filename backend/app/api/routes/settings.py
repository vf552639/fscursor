from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.services import system_config_service

router = APIRouter(prefix="/settings", tags=["settings"])


class ConfigUpdate(BaseModel):
    value: str


class ConfigItem(BaseModel):
    key: str
    value: str
    editable: bool = True


@router.get("/config", response_model=list[ConfigItem])
async def list_config(db: AsyncSession = Depends(get_db)) -> list[ConfigItem]:
    items = await system_config_service.get_all(db)
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
    key: str, payload: ConfigUpdate, db: AsyncSession = Depends(get_db)
) -> ConfigItem:
    if key not in system_config_service.EDITABLE_KEYS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Config key '{key}' is not editable",
        )
    item = await system_config_service.upsert(db, key, payload.value)
    return ConfigItem(key=item.key, value=item.value, editable=True)
