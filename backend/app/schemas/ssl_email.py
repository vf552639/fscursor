from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class SslEmailCreate(BaseModel):
    email: str
    usage_cap: int = Field(default=100, ge=1)


class SslEmailUpdate(BaseModel):
    is_active: Optional[bool] = None
    usage_cap: Optional[int] = Field(default=None, ge=1)


class SslEmailResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    usage_count: int
    usage_cap: int
    is_active: bool
    created_at: datetime
    updated_at: datetime
