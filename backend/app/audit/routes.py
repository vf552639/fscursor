from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import service as audit_service
from app.audit.models import AuditLog
from app.audit.schemas import AuditLogCreate, AuditLogOut
from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.core.database import get_db

router = APIRouter(prefix="/audit", tags=["audit"])


@router.post("/log", status_code=status.HTTP_204_NO_CONTENT)
async def append_audit(
    body: AuditLogCreate,
    request: Request,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> None:
    try:
        await audit_service.log(
            db,
            user_id=user.id,
            action=body.action,
            target_type=body.target_type,
            target_id=body.target_id,
            device_id=body.device_id,
            ip=request.client.host if request.client else None,
            metadata=body.metadata,
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e


@router.get("/log", response_model=list[AuditLogOut])
async def list_audit(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
    limit: int = 100,
) -> list[AuditLog]:
    result = await db.execute(
        select(AuditLog)
        .where(AuditLog.user_id == user.id)
        .order_by(AuditLog.ts.desc())
        .limit(min(limit, 500))
    )
    rows = list(result.scalars().all())
    out: list[AuditLogOut] = []
    for r in rows:
        out.append(
            AuditLogOut(
                id=r.id,
                action=r.action,
                target_type=r.target_type,
                target_id=r.target_id,
                device_id=r.device_id,
                ip=r.ip,
                metadata=r.metadata_,
                ts=r.ts,
            )
        )
    return out
