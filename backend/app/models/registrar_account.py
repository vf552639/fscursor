from typing import Optional

from sqlalchemy import Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.base import TimestampMixin


class RegistrarAccount(Base, TimestampMixin):
    __tablename__ = "registrar_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    api_key_encrypted: Mapped[Optional[str]] = mapped_column(Text)
    api_secret_encrypted: Mapped[Optional[str]] = mapped_column(Text)
    api_user: Mapped[Optional[str]] = mapped_column(String(128))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    domains: Mapped[list["Domain"]] = relationship(back_populates="registrar")
