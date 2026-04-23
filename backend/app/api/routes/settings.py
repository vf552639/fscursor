from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/settings", tags=["settings"])


class ConfigUpdate(BaseModel):
    value: str


class ConfigItem(BaseModel):
    key: str
    value: str
    editable: bool = True


_SYSTEM_CONFIG: dict[str, str] = {
    "API Base URL": "http://localhost:8100/api",
    "Frontend URL": "http://localhost:3100",
    "Backend Port": "8100",
    "Postgres Port": "5532",
    "Redis Port": "6479",
    "Celery Workers": "2",
    "Task Time Limit": "60 min",
    "FastPanel Poll": "3 seconds",
}


@router.get("/config", response_model=list[ConfigItem])
async def list_config() -> list[ConfigItem]:
    return [ConfigItem(key=key, value=value, editable=True) for key, value in _SYSTEM_CONFIG.items()]


@router.put("/config/{key}", response_model=ConfigItem)
async def update_config(key: str, payload: ConfigUpdate) -> ConfigItem:
    if key not in _SYSTEM_CONFIG:
        _SYSTEM_CONFIG[key] = payload.value
    else:
        _SYSTEM_CONFIG[key] = payload.value
    return ConfigItem(key=key, value=_SYSTEM_CONFIG[key], editable=True)
