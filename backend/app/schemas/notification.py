from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class NotificationResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    type: str
    entity_type: str
    entity_id: int
    title: str
    message: Optional[str] = None
    is_read: bool
    read_at: Optional[datetime] = None
    created_at: datetime


class NotificationMarkReadRequest(BaseModel):
    ids: list[int] = Field(default_factory=list)


class UnreadCountResponse(BaseModel):
    count: int
