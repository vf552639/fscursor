from datetime import date, datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin


class Server(Base, TimestampMixin):
    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
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
    fastpanel_password_encrypted: Mapped[Optional[str]] = mapped_column(Text)
    notes: Mapped[Optional[str]] = mapped_column(Text)
    uptime_seconds: Mapped[Optional[int]] = mapped_column(BigInteger)
    last_check_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    last_check_ok: Mapped[Optional[bool]] = mapped_column(Boolean)
    last_check_error: Mapped[Optional[str]] = mapped_column(Text)

    secret: Mapped[Optional["ServerSecret"]] = relationship(
        back_populates="server", uselist=False, cascade="all, delete-orphan"
    )
    domains: Mapped[list["Domain"]] = relationship(back_populates="server")

    @property
    def has_ssh(self) -> bool:
        return bool(self.secret and self.secret.ssh_password_encrypted)


class ServerSecret(Base):
    __tablename__ = "server_secrets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(
        ForeignKey("servers.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    ssh_password_encrypted: Mapped[Optional[str]] = mapped_column(Text)

    server: Mapped["Server"] = relationship(back_populates="secret")
