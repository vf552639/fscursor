import uuid
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field


class AuditLogCreate(BaseModel):
    action: str = Field(min_length=1, max_length=64)
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    device_id: Optional[uuid.UUID] = None
    metadata: Optional[dict[str, Any]] = None


class AuditLogOut(BaseModel):
    id: int
    action: str
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    device_id: Optional[uuid.UUID] = None
    ip: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    ts: datetime

    class Config:
        from_attributes = True
