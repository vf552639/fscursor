import uuid
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditLog

SAFE_ACTIONS = frozenset(
    {
        "domain.create",
        "domain.update",
        "domain.delete",
        "server.create",
        "server.update",
        "server.delete",
        "cf.account.create",
        "cf.account.update",
        "cf.account.delete",
        "registrar.account.create",
        "registrar.account.update",
        "registrar.account.delete",
        "device.action.start",
        "device.action.complete",
        "device.action.fail",
        "auth.login",
        "auth.logout",
        "auth.password_change",
        "auth.recovery",
        "auth.totp_enable",
    }
)


async def log(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    action: str,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    device_id: Optional[uuid.UUID] = None,
    ip: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    if action not in SAFE_ACTIONS:
        raise ValueError(f"unknown audit action: {action}")
    db.add(
        AuditLog(
            user_id=user_id,
            action=action,
            target_type=target_type,
            target_id=target_id,
            device_id=device_id,
            ip=ip,
            metadata_=metadata,
        )
    )
