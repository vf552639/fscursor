import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, LargeBinary, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    salt: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    auth_key_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # aead(VK, KEK): ключ хранилища, которым зашифрованы блобы, обёрнутый ключом
    # из пароля. Сервер видит только байты.
    # NULL = аккаунт до перехода на VK: у него VK == выведенный из пароля ключ,
    # поэтому блобы и recovery-блоб остаются верными как есть, а обёртка
    # появится на первом входе клиента (`POST /auth/vault-key/init`). Бэкфилить
    # нечем — сервер не знает ни VK, ни KEK.
    wrapped_vault_key: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    # NOTE: плейнтекст — осознанный временный компромисс (фаза «для себя»), см.
    # docs/security/TOTP_STORAGE.md. Зашифровать перед продуктовой фазой.
    totp_secret: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    email_confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    email_confirm_token_hash: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True, nullable=False)
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class RecoveryBlob(Base):
    __tablename__ = "recovery_blob"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # bcrypt-хеш recovery_auth_key, выведенного клиентом из recovery-фразы
    # (Argon2id, контекст "sdmp-recovery-key-v1"). Сервер не может ни расшифровать
    # блоб, ни восстановить фразу — только проверить владение ею.
    # NULL = recovery настроен до миграции 014; восстановление по нему запрещено.
    recovery_auth_key_hash: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=text("now()"), nullable=False
    )


class SyncState(Base):
    __tablename__ = "sync_state"

    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    current_version: Mapped[int] = mapped_column(
        BigInteger, nullable=False, server_default=text("0")
    )
