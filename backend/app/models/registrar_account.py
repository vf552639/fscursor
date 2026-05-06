import uuid
from typing import TYPE_CHECKING, Optional

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin

if TYPE_CHECKING:
    from app.models.domain import Domain


class RegistrarAccount(Base, TimestampMixin):
    __tablename__ = "registrar_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sync_version: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    sync_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    api_key_blob_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True
    )
    api_secret_blob_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True
    )
    api_user: Mapped[Optional[str]] = mapped_column(String(128))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    domains: Mapped[list["Domain"]] = relationship(back_populates="registrar")
