import uuid
from typing import TYPE_CHECKING, Optional

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin

if TYPE_CHECKING:
    from app.models.domain import Domain


class CloudflareAccount(Base, TimestampMixin):
    __tablename__ = "cloudflare_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sync_version: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    sync_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    name: Mapped[str] = mapped_column(String(255), nullable=False)
    account_id: Mapped[Optional[str]] = mapped_column(String(128))
    api_token_blob_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    domains: Mapped[list["Domain"]] = relationship(back_populates="cloudflare_account")
