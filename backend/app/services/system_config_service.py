from collections.abc import Mapping
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.system_config import SystemConfig
from app.sync.service import touch_entity_sync

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


class ConfigOwnershipError(PermissionError):
    """Попытка записать ключ конфигурации, принадлежащий другому пользователю.

    Таблица `system_config` имеет первичный ключ из одного столбца `key`, то
    есть строка на ключ ровно одна на всю установку. Столбец `user_id` — это
    не «шардирование по пользователю» (оно невозможно без смены PK), а отметка
    владельца: кто первым занял глобальную строку, тот ей и распоряжается.
    """

    def __init__(self, key: str) -> None:
        self.key = key
        super().__init__(f"Config key '{key}' belongs to another user")


def _is_writable_by(row: SystemConfig, user_id: UUID) -> bool:
    """Строку можно писать, если она ничья (`user_id IS NULL`) или наша.

    Единственная точка, где решается вопрос «можно ли трогать эту строку».
    И `upsert`, и `ensure_defaults` обязаны спрашивать именно её, иначе
    `ensure_defaults` (он вызывается из `get_all`, то есть с обычного GET)
    превратился бы в обход проверки из `upsert`.
    """
    return row.user_id is None or row.user_id == user_id


async def ensure_defaults(db: AsyncSession, user_id: UUID) -> None:
    for key, value in DEFAULT_SYSTEM_CONFIG.items():
        existing = await db.get(SystemConfig, key)
        if existing is None:
            row = SystemConfig(key=key, value=value, user_id=user_id)
            await touch_entity_sync(db, user_id, row)
            db.add(row)
        elif _is_writable_by(existing, user_id) and existing.user_id is None:
            # Ничья строка достаётся тому, кто первым за ней пришёл. Чужую —
            # `_is_writable_by` вернёт False — не забираем и не трогаем вовсе:
            # иначе обычный GET /api/settings/config был бы обходом 403 из
            # `upsert`. Своя строка уже размечена, второй раз её не трогаем.
            existing.user_id = user_id
            await touch_entity_sync(db, user_id, existing)
    await db.commit()


async def get_all(db: AsyncSession, user_id: UUID) -> list[SystemConfig]:
    await ensure_defaults(db, user_id)
    result = await db.execute(
        select(SystemConfig)
        .where(or_(SystemConfig.user_id == user_id, SystemConfig.user_id.is_(None)))
        .order_by(SystemConfig.key.asc())
    )
    return list(result.scalars().all())


async def get(db: AsyncSession, key: str, user_id: UUID) -> SystemConfig | None:
    result = await db.execute(
        select(SystemConfig).where(
            SystemConfig.key == key,
            or_(SystemConfig.user_id == user_id, SystemConfig.user_id.is_(None)),
        )
    )
    return result.scalar_one_or_none()


async def upsert(db: AsyncSession, key: str, value: str, user_id: UUID) -> SystemConfig:
    config = await db.get(SystemConfig, key)
    if config is None:
        config = SystemConfig(key=key, value=value, user_id=user_id)
        await touch_entity_sync(db, user_id, config)
        db.add(config)
    else:
        if not _is_writable_by(config, user_id):
            raise ConfigOwnershipError(key)
        config.value = value
        if config.user_id is None:
            config.user_id = user_id
        await touch_entity_sync(db, user_id, config)
    await db.commit()
    await db.refresh(config)
    return config
