from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ServerBase(BaseModel):
    name: str
    ip_address: str
    ssh_port: int = 22
    ssh_user: str = "root"
    os: Optional[str] = None
    purchase_date: Optional[date] = None
    expiry_date: Optional[date] = None


class ServerCreate(ServerBase):
    ssh_password_blob_id: Optional[UUID] = None
    fastpanel_user: Optional[str] = None
    fastpanel_password_blob_id: Optional[UUID] = None
    fastpanel_url: Optional[str] = None
    fastpanel_status: Optional[str] = "not_installed"


class ServerUpdate(BaseModel):
    name: Optional[str] = None
    ip_address: Optional[str] = None
    ssh_port: Optional[int] = None
    ssh_user: Optional[str] = None
    os: Optional[str] = None
    status: Optional[str] = None
    purchase_date: Optional[date] = None
    expiry_date: Optional[date] = None
    ssh_password_blob_id: Optional[UUID] = None
    fastpanel_user: Optional[str] = None
    fastpanel_password_blob_id: Optional[UUID] = None
    fastpanel_url: Optional[str] = None
    fastpanel_status: Optional[str] = None


class ServerResponse(ServerBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str
    fastpanel_status: str
    fastpanel_url: Optional[str] = None
    fastpanel_user: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    has_ssh: bool = False
    uptime_seconds: Optional[int] = None
    cpu_usage_pct: Optional[int] = None
    cpu_count: Optional[int] = None
    ram_used_mb: Optional[int] = None
    ram_total_mb: Optional[int] = None
    disk_used_gb: Optional[int] = None
    disk_total_gb: Optional[int] = None
    net_in_kbps: Optional[int] = None
    net_out_kbps: Optional[int] = None
    os_pretty: Optional[str] = None
    kernel: Optional[str] = None
    fastpanel_version: Optional[str] = None
    fastpanel_port: Optional[int] = None
    metrics_collected_at: Optional[datetime] = None
    last_check_at: Optional[datetime] = None
    last_check_ok: Optional[bool] = None
    last_check_error: Optional[str] = None
    ssh_password_blob_id: Optional[UUID] = None
    fastpanel_password_blob_id: Optional[UUID] = None


class ServerListResponse(BaseModel):
    items: list[ServerResponse]
    total: int


class SSHTestResponse(BaseModel):
    success: bool
    message: str


class InstallFastpanelResponse(BaseModel):
    task_id: str
    server_id: int


class FastpanelStatusResponse(BaseModel):
    server_id: int
    fastpanel_status: str
    fastpanel_url: Optional[str] = None
    fastpanel_user: Optional[str] = None
    log_tail: list[str]


class SyncDomainsResponse(BaseModel):
    created: int
    linked: int
    total: int
    error: Optional[str] = None


class ServerBulkImportError(BaseModel):
    row: int
    server: str
    reason: str


class ServerBulkImportResponse(BaseModel):
    created: int
    skipped: int
    errors: list[ServerBulkImportError]
    errors_csv_url: Optional[str] = None
