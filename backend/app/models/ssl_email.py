import uuid
from typing import Optional

from sqlalchemy import BigInteger, Boolean, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.base import TimestampMixin


class SslEmail(Base, TimestampMixin):
    __tablename__ = "ssl_email_pool"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    sync_version: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    sync_deleted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    usage_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    usage_cap: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
