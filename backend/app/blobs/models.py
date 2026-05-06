import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, LargeBinary, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class BlobStorage(Base):
    __tablename__ = "blob_storage"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    blob_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
