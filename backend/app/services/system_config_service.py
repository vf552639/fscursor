from collections.abc import Mapping

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system_config import SystemConfig

EDITABLE_KEYS: set[str] = {
    "API Base URL",
    "Frontend URL",
    "Backend Port",
    "Postgres Port",
    "Redis Port",
    "Celery Workers",
    "Task Time Limit",
    "FastPanel Poll",
    "Webhook Enabled",
    "Webhook URL",
    "Webhook Secret",
    "Telegram Enabled",
    "Auto Temp Mail Enabled",
}

DEFAULT_SYSTEM_CONFIG: Mapping[str, str] = {
    "API Base URL": "http://localhost:8100/api",
    "Frontend URL": "http://localhost:3100",
    "Backend Port": "8100",
    "Postgres Port": "5532",
    "Redis Port": "6479",
    "Celery Workers": "2",
    "Task Time Limit": "60 min",
    "FastPanel Poll": "3 seconds",
    "Webhook Enabled": "false",
    "Webhook URL": "",
    "Webhook Secret": "",
    "Telegram Enabled": "false",
    "Auto Temp Mail Enabled": "false",
}


async def ensure_defaults(db: AsyncSession) -> None:
    for key, value in DEFAULT_SYSTEM_CONFIG.items():
        existing = await db.get(SystemConfig, key)
        if existing is None:
            db.add(SystemConfig(key=key, value=value))
    await db.commit()


async def get_all(db: AsyncSession) -> list[SystemConfig]:
    await ensure_defaults(db)
    result = await db.execute(select(SystemConfig).order_by(SystemConfig.key.asc()))
    return list(result.scalars().all())


async def get(db: AsyncSession, key: str) -> SystemConfig | None:
    return await db.get(SystemConfig, key)


async def upsert(db: AsyncSession, key: str, value: str) -> SystemConfig:
    config = await db.get(SystemConfig, key)
    if config is None:
        config = SystemConfig(key=key, value=value)
        db.add(config)
    else:
        config.value = value
    await db.commit()
    await db.refresh(config)
    return config
