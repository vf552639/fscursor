import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin

if TYPE_CHECKING:
    from app.models.domain import Domain


class Server(Base, TimestampMixin):
    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sync_version: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    sync_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    ip_address: Mapped[str] = mapped_column(String(45), nullable=False)
    ssh_port: Mapped[int] = mapped_column(Integer, default=22, nullable=False)
    ssh_user: Mapped[str] = mapped_column(String(64), default="root", nullable=False)
    os: Mapped[Optional[str]] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(32), default="new", nullable=False)
    purchase_date: Mapped[Optional[date]] = mapped_column(Date)
    expiry_date: Mapped[Optional[date]] = mapped_column(Date)
    fastpanel_status: Mapped[str] = mapped_column(String(32), default="not_installed", nullable=False)
    fastpanel_url: Mapped[Optional[str]] = mapped_column(String(512))
    fastpanel_user: Mapped[Optional[str]] = mapped_column(String(128))
    ssh_password_blob_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True
    )
    fastpanel_password_blob_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True
    )
    uptime_seconds: Mapped[Optional[int]] = mapped_column(BigInteger)
    cpu_usage_pct: Mapped[Optional[int]] = mapped_column(Integer)
    cpu_count: Mapped[Optional[int]] = mapped_column(Integer)
    ram_used_mb: Mapped[Optional[int]] = mapped_column(Integer)
    ram_total_mb: Mapped[Optional[int]] = mapped_column(Integer)
    disk_used_gb: Mapped[Optional[int]] = mapped_column(Integer)
    disk_total_gb: Mapped[Optional[int]] = mapped_column(Integer)
    net_in_kbps: Mapped[Optional[int]] = mapped_column(Integer)
    net_out_kbps: Mapped[Optional[int]] = mapped_column(Integer)
    os_pretty: Mapped[Optional[str]] = mapped_column(String(255))
    kernel: Mapped[Optional[str]] = mapped_column(String(128))
    fastpanel_version: Mapped[Optional[str]] = mapped_column(String(64))
    fastpanel_port: Mapped[Optional[int]] = mapped_column(Integer, default=8888)
    metrics_collected_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_check_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_check_ok: Mapped[Optional[bool]] = mapped_column(Boolean)
    last_check_error: Mapped[Optional[str]] = mapped_column(Text)

    domains: Mapped[list["Domain"]] = relationship(back_populates="server")

    @property
    def has_ssh(self) -> bool:
        return self.ssh_password_blob_id is not None
