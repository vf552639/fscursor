from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class CloudflareAccountBase(BaseModel):
    name: str
    account_id: Optional[str] = None
    is_active: bool = True


class CloudflareAccountCreate(CloudflareAccountBase):
    # Незнакомое поле — 422, а не тишина: плейнтекст `api_token` с дефолтным
    # `extra="ignore"` молча выбрасывался, а аккаунт оставался с
    # `api_token_blob_id = NULL`. `forbid` только здесь и на `Update`:
    # `CloudflareAccountResponse` наследует ту же базу и собирается из ORM.
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    api_token_blob_id: Optional[UUID] = None


class CloudflareAccountUpdate(BaseModel):
    # См. `CloudflareAccountCreate`.
    model_config = ConfigDict(extra="forbid")

    name: Optional[str] = Field(default=None, min_length=1)
    account_id: Optional[str] = None
    api_token_blob_id: Optional[UUID] = None
    is_active: Optional[bool] = None


class CloudflareTestResponse(BaseModel):
    success: bool
    message: str
    account_email: Optional[str] = None


class CloudflareSyncResponse(BaseModel):
    updated: int
    skipped: int
    total_zones: int


class CloudflareAccountResponse(CloudflareAccountBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    api_token_blob_id: Optional[UUID] = None
    api_token_masked: Optional[str] = None
    sync_result: Optional[CloudflareSyncResponse] = None
    sync_warning: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class ZoneResponse(BaseModel):
    id: str
    name: str
    status: Optional[str] = None
    name_servers: list[str] = []
    original_name_servers: list[str] = []
    paused: Optional[bool] = None


class DnsRecordBase(BaseModel):
    type: str
    name: str
    content: str
    ttl: int = 1
    proxied: bool = False


class DnsRecordCreate(DnsRecordBase):
    priority: Optional[int] = None


class DnsRecordUpdate(BaseModel):
    type: Optional[str] = None
    name: Optional[str] = None
    content: Optional[str] = None
    ttl: Optional[int] = None
    proxied: Optional[bool] = None
    priority: Optional[int] = None


class DnsRecordResponse(BaseModel):
    id: str
    type: str
    name: str
    content: str
    ttl: int
    proxied: bool
    zone_id: Optional[str] = None


class NameserversResponse(BaseModel):
    zone_id: str
    name_servers: list[str]


class PurgeResponse(BaseModel):
    success: bool
    message: Optional[str] = None


class CloudflareRaw(BaseModel):
    result: Any = None
