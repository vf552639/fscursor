from datetime import date, datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


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
    ns_check_mode: Optional[str] = None
    site_user: Optional[str] = None
    site_path: Optional[str] = None
    ssl_status: Optional[str] = None
    ssl_expires_at: Optional[datetime] = None
    ssl_issuer: Optional[str] = None
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    nginx_override: Optional[str] = None
    nginx_presets: Optional[dict] = None
    last_provision_error: Optional[str] = None


class DomainResponse(DomainBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str
    ns_status: Optional[str] = None
    ns_updated_at: Optional[datetime] = None
    site_user: Optional[str] = None
    site_path: Optional[str] = None
    ftp_user: Optional[str] = None
    ssl_status: Optional[str] = None
    ssl_email_used: Optional[str] = None
    ssl_expires_at: Optional[datetime] = None
    ssl_issuer: Optional[str] = None
    php_version: Optional[str] = None
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    ns_check_mode: Optional[str] = None
    nginx_override: Optional[str] = None
    nginx_presets: Optional[dict] = None
    last_provision_error: Optional[str] = None
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


class DomainFtpCredentials(BaseModel):
    domain_id: int
    ftp_user: Optional[str] = None
    ftp_password: Optional[str] = None


class DomainDbCredentials(BaseModel):
    domain_id: int
    db_name: Optional[str] = None
    db_user: Optional[str] = None
    db_password: Optional[str] = None


class CreateSiteRequest(BaseModel):
    site_only: bool = False


class NginxOverrideRequest(BaseModel):
    snippet: str = ""
    presets: dict = Field(default_factory=dict)


class NginxOverrideResponse(BaseModel):
    domain_id: int
    snippet: str
    presets: dict


class MarkNsSetRequest(BaseModel):
    set: bool = True


class RefreshSslResponse(BaseModel):
    domain_id: int
    has_certificate: bool
    expires_at: Optional[datetime] = None
    issuer: Optional[str] = None
    is_letsencrypt: bool = False


class ProvisionResponse(BaseModel):
    task_id: str
    task_log_id: int
    domain_id: int


class BulkProvisionRequest(BaseModel):
    domain_ids: list[int]


class BulkProvisionResponse(BaseModel):
    task_ids: list[str]


class BulkFullSetupRequest(BaseModel):
    domain_ids: list[int]
    server_id: int
    cloudflare_account_id: int
    registrar_id: Optional[int] = None


class BulkFullSetupResponse(BaseModel):
    task_ids: list[str]
    task_log_ids: list[int]


class DomainBulkImportError(BaseModel):
    row: int
    domain: str
    reason: str


class DomainBulkImportResponse(BaseModel):
    created: int
    skipped: int
    errors: list[DomainBulkImportError]
    errors_csv_url: Optional[str] = None


class DomainBulkImportRequest(BaseModel):
    has_header: bool = Field(default=True)
    default_registrar_id: Optional[int] = None
