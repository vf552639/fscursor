import uuid
from datetime import date, datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import JSON, BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin

if TYPE_CHECKING:
    from app.models.cloudflare_account import CloudflareAccount
    from app.models.registrar_account import RegistrarAccount
    from app.models.server import Server


class Domain(Base, TimestampMixin):
    __tablename__ = "domains"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sync_version: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    sync_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    domain_name: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="new", nullable=False)
    registrar_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("registrar_accounts.id", ondelete="SET NULL")
    )
    server_id: Mapped[Optional[int]] = mapped_column(ForeignKey("servers.id", ondelete="SET NULL"))
    cloudflare_account_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("cloudflare_accounts.id", ondelete="SET NULL")
    )
    cloudflare_zone_id: Mapped[Optional[str]] = mapped_column(String(128))
    cloudflare_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    expiry_date: Mapped[Optional[date]] = mapped_column(Date)
    purchase_date: Mapped[Optional[date]] = mapped_column(Date)
    ns_status: Mapped[Optional[str]] = mapped_column(String(32))
    ns_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    site_user: Mapped[Optional[str]] = mapped_column(String(64))
    site_path: Mapped[Optional[str]] = mapped_column(String(255))
    ftp_user: Mapped[Optional[str]] = mapped_column(String(64))
    ftp_password_blob_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True
    )
    ssl_status: Mapped[Optional[str]] = mapped_column(String(16), default="none")
    ssl_email_used: Mapped[Optional[str]] = mapped_column(String(255))
    ssl_expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    ssl_issuer: Mapped[Optional[str]] = mapped_column(String(64))
    php_version: Mapped[Optional[str]] = mapped_column(String(16))
    db_name: Mapped[Optional[str]] = mapped_column(String(64))
    db_user: Mapped[Optional[str]] = mapped_column(String(64))
    db_password_blob_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True
    )
    ns_check_mode: Mapped[Optional[str]] = mapped_column(String(16), default="auto")
    nginx_override: Mapped[Optional[str]] = mapped_column(Text)
    nginx_presets: Mapped[Optional[dict]] = mapped_column(JSON)
    last_provision_error: Mapped[Optional[str]] = mapped_column(Text)

    registrar: Mapped[Optional["RegistrarAccount"]] = relationship(
        back_populates="domains"
    )
    server: Mapped[Optional["Server"]] = relationship(back_populates="domains")
    cloudflare_account: Mapped[Optional["CloudflareAccount"]] = relationship(
        back_populates="domains"
    )
