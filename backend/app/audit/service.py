import uuid
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditLog

SAFE_ACTIONS = frozenset(
    {
        "domain.create",
        "domain.update",
        "domain.delete",
        "domain.bulk_create",
        "domain.bulk_import",
        "domain.bulk_assign_server",
        "domain.bulk_assign_cloudflare",
        # Связки full-setup пачке (`POST /domains/full-setup`). Шаги, требующие
        # токена (зона Cloudflare, NS у регистратора), пишет в аудит десктоп
        # под `cf.zone.create` / `registrar.ns_set`.
        "domain.full_setup",
        "server.create",
        "server.update",
        "server.delete",
        "server.bulk_import",
        # Приём снимка метрик с десктопа (`POST /servers/{id}/metrics`).
        "server.metrics",
        "cf.account.create",
        "cf.account.update",
        "cf.account.delete",
        "registrar.account.create",
        "registrar.account.update",
        "registrar.account.delete",
        "cf.zone.create",
        "cf.dns.create",
        "cf.dns.update",
        "cf.dns.delete",
        "cf.cache_purge",
        "registrar.ns_set",
        "server.fastpanel_install",
        "device.action.start",
        "device.action.complete",
        "device.action.fail",
        "auth.login",
        "auth.logout",
        "auth.password_change",
        "auth.recovery",
        "auth.recovery_setup",
        "auth.totp_enable",
        "blob.upsert",
        "blob.delete",
        "settings.config_update",
        "settings.notification_test",
        "notification.mark_read",
        "notification.delete",
        "notification.check_renewals",
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
