from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict


class DomainBase(BaseModel):
    domain_name: str
    registrar_id: Optional[int] = None
    server_id: Optional[int] = None
    cloudflare_account_id: Optional[int] = None
    cloudflare_zone_id: Optional[str] = None
    cloudflare_enabled: bool = False
    expiry_date: Optional[date] = None
    purchase_date: Optional[date] = None


class DomainCreate(DomainBase):
    pass


class DomainUpdate(BaseModel):
    domain_name: Optional[str] = None
    status: Optional[str] = None
    registrar_id: Optional[int] = None
    server_id: Optional[int] = None
    cloudflare_account_id: Optional[int] = None
    cloudflare_zone_id: Optional[str] = None
    cloudflare_enabled: Optional[bool] = None
    expiry_date: Optional[date] = None
    purchase_date: Optional[date] = None
    ns_status: Optional[str] = None


class DomainResponse(DomainBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str
    ns_status: Optional[str] = None
    ns_updated_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class DomainBulkCreate(BaseModel):
    domains_text: str
    registrar_id: Optional[int] = None


class DomainBulkCreateResponse(BaseModel):
    created: list[DomainResponse]
    skipped: list[str]


class DomainBulkCreateItem(BaseModel):
    domain_name: str
    registrar_id: Optional[int] = None
    registrar_name: Optional[str] = None


class DomainBulkStructuredCreate(BaseModel):
    items: list[DomainBulkCreateItem]


class DomainBulkAssignServer(BaseModel):
    domain_ids: list[int]
    server_id: Optional[int] = None


class DomainBulkAssignCloudflare(BaseModel):
    domain_ids: list[int]
    cloudflare_account_id: Optional[int] = None


class DomainBulkAssignResponse(BaseModel):
    updated: int


class SetNSResponse(BaseModel):
    task_id: str
    domain_id: int


class BulkSetNSRequest(BaseModel):
    domain_ids: list[int]


class BulkSetNSResponse(BaseModel):
    task_ids: list[str]
