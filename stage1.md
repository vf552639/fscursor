# Stage 1 — Auth + Sync Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backend supports register, login, session-based auth, BIP39 recovery, master-password change, TOTP, sync API, opaque blob CRUD, and per-user scoping of all kept resources. SSH/Cloudflare/registrar execution endpoints and services are deleted.

**Architecture:** Add `backend/app/auth/`, `backend/app/sync/`, `backend/app/blobs/`, `backend/app/audit/` modules. Single Alembic migration `011_zero_knowledge_v1` creates new tables, adds `user_id` FK to existing tables, drops `*_encrypted` columns. Server bcrypt-checks `auth_key` (which is itself derived client-side from master password via Argon2id). Sessions are `itsdangerous`-signed cookies. Rate limiting via `slowapi` + Redis. Email sending via Resend HTTP API.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, Postgres, Redis, `argon2-cffi`, `bcrypt`, `itsdangerous`, `slowapi`, `pyotp`, `resend`, `email-validator`, `pytest-asyncio`.

---

## Task 1: Migration `011_zero_knowledge_v1`

Creates `users`, `sessions`, `blob_storage`, `audit_log`, `recovery_blob`, `sync_state`. Adds `user_id` FK + index to: `domains`, `servers`, `cloudflare_accounts`, `registrar_accounts`, `notifications`, `task_logs`, `ssl_emails`, `system_config`, `activity_logs`. Drops encrypted columns and `server_secrets` table. Adds `*_blob_id` FK columns.

**Files:**
- Create: `backend/alembic/versions/011_zero_knowledge_v1.py`
- Modify: `backend/app/main.py:16` (`EXPECTED_ALEMBIC_HEAD = "011_zero_knowledge_v1"`)
- Test: `backend/tests/test_migration_011.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/test_migration_011.py`:

```python
import pytest
from sqlalchemy import inspect, text

from app.core.database import engine


@pytest.mark.asyncio
async def test_011_creates_zero_knowledge_tables():
    async with engine.connect() as conn:
        def check(sync_conn):
            insp = inspect(sync_conn)
            tables = set(insp.get_table_names())
            assert {"users", "sessions", "blob_storage", "audit_log", "recovery_blob", "sync_state"} <= tables
            assert "server_secrets" not in tables, "server_secrets must be dropped"
            domain_cols = {c["name"] for c in insp.get_columns("domains")}
            assert "user_id" in domain_cols
            assert "ftp_password_encrypted" not in domain_cols
            assert "db_password_encrypted" not in domain_cols
            assert "ftp_password_blob_id" in domain_cols
            assert "db_password_blob_id" in domain_cols
            server_cols = {c["name"] for c in insp.get_columns("servers")}
            assert "user_id" in server_cols
            assert "ssh_password_encrypted" not in server_cols
            assert "fastpanel_password_encrypted" not in server_cols
            assert "ssh_password_blob_id" in server_cols
            assert "fastpanel_password_blob_id" in server_cols
        await conn.run_sync(check)
```

Run, expect FAIL: `pytest backend/tests/test_migration_011.py -v`.

- [ ] **Step 2: Write the migration**

`backend/alembic/versions/011_zero_knowledge_v1.py`:

```python
"""zero-knowledge v1: add users, sessions, blobs, scope existing tables

Revision ID: 011_zero_knowledge_v1
Revises: 010_domain_extras
Create Date: 2026-05-06

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "011_zero_knowledge_v1"
down_revision: str | None = "010_domain_extras"
branch_labels = None
depends_on = None


SCOPED_TABLES = (
    "domains",
    "servers",
    "cloudflare_accounts",
    "registrar_accounts",
    "notifications",
    "task_logs",
    "ssl_emails",
    "system_config",
    "activity_logs",
)


def upgrade() -> None:
    # 1) users
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(255), nullable=False, unique=True, index=True),
        sa.Column("salt", sa.LargeBinary, nullable=False),
        sa.Column("auth_key_hash", sa.LargeBinary, nullable=False),
        sa.Column("totp_secret", sa.String(64), nullable=True),
        sa.Column("email_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("email_confirm_token_hash", sa.LargeBinary, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # 2) sessions
    op.create_table(
        "sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("token_hash", sa.LargeBinary, nullable=False, unique=True),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("ip", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )

    # 3) blob_storage
    op.create_table(
        "blob_storage",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("ciphertext", sa.LargeBinary, nullable=False),
        sa.Column("blob_kind", sa.String(64), nullable=False),
        sa.Column("version", sa.BigInteger, nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("deleted", sa.Boolean, nullable=False, server_default=sa.text("false")),
    )
    op.create_index("ix_blob_user_version", "blob_storage", ["user_id", "version"])

    # 4) audit_log
    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("target_type", sa.String(64), nullable=True),
        sa.Column("target_id", sa.String(64), nullable=True),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("ip", sa.String(45), nullable=True),
        sa.Column("metadata", postgresql.JSONB, nullable=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # 5) recovery_blob
    op.create_table(
        "recovery_blob",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("ciphertext", sa.LargeBinary, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    # 6) sync_state
    op.create_table(
        "sync_state",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("current_version", sa.BigInteger, nullable=False, server_default=sa.text("0")),
    )

    # 7) Add user_id to existing tables
    for tbl in SCOPED_TABLES:
        op.add_column(tbl, sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True))
        op.create_foreign_key(f"fk_{tbl}_user_id", tbl, "users", ["user_id"], ["id"], ondelete="CASCADE")
        op.create_index(f"ix_{tbl}_user_id", tbl, ["user_id"])

    # 8) Add version + updated_at + deleted to scoped tables (sync support)
    for tbl in SCOPED_TABLES:
        op.add_column(tbl, sa.Column("sync_version", sa.BigInteger, nullable=False, server_default=sa.text("0")))
        op.add_column(tbl, sa.Column("sync_deleted", sa.Boolean, nullable=False, server_default=sa.text("false")))
        # updated_at already present on most tables; skip if exists handled by Alembic on conflict

    # 9) Add *_blob_id columns
    op.add_column("domains", sa.Column("ftp_password_blob_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True))
    op.add_column("domains", sa.Column("db_password_blob_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True))
    op.add_column("servers", sa.Column("ssh_password_blob_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True))
    op.add_column("servers", sa.Column("fastpanel_password_blob_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True))
    op.add_column("cloudflare_accounts", sa.Column("api_token_blob_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True))
    op.add_column("registrar_accounts", sa.Column("api_key_blob_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True))
    op.add_column("registrar_accounts", sa.Column("api_secret_blob_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("blob_storage.id", ondelete="SET NULL"), nullable=True))

    # 10) Drop encrypted columns and server_secrets table
    op.drop_column("domains", "ftp_password_encrypted")
    op.drop_column("domains", "db_password_encrypted")
    op.drop_column("servers", "ssh_password_encrypted")
    op.drop_column("servers", "fastpanel_password_encrypted")
    op.drop_table("server_secrets")
    op.drop_column("cloudflare_accounts", "api_token_encrypted")
    op.drop_column("registrar_accounts", "api_key_encrypted")
    op.drop_column("registrar_accounts", "api_secret_encrypted")


def downgrade() -> None:
    raise NotImplementedError("011 is non-reversible; restore from backup if needed")
```

- [ ] **Step 3: Apply migration and run test**

```bash
cd backend && alembic upgrade head
pytest tests/test_migration_011.py -v
```

Expected: PASS.

- [ ] **Step 4: Update `EXPECTED_ALEMBIC_HEAD`**

Edit `backend/app/main.py:16`:

```python
EXPECTED_ALEMBIC_HEAD = "011_zero_knowledge_v1"
```

Update `backend/tests/test_lifespan.py` to expect `011_zero_knowledge_v1`. Run all tests, expect both PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/alembic/versions/011_zero_knowledge_v1.py backend/app/main.py backend/tests/
git commit -m "feat(db): migration 011 — zero-knowledge tables and per-user scoping"
```

---

## Task 2: Update `Settings` and drop `ENCRYPTION_KEY`

`ENCRYPTION_KEY` is no longer used (no shared server-side encryption). Replace with new settings.

**Files:**
- Modify: `backend/app/core/config.py`
- Modify: `.env.example`

- [ ] **Step 1: Update `Settings` class**

Edit `backend/app/core/config.py`:

```python
import uuid
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    SUPABASE_DB_URL: str
    SUPABASE_URL: str
    SUPABASE_KEY: str
    REDIS_URL: str
    CELERY_BROKER_URL: str
    CELERY_RESULT_BACKEND: str

    # Auth/session
    SECRET_KEY: str  # itsdangerous signing
    SESSION_COOKIE_NAME: str = "sdmp_session"
    SESSION_TTL_SECONDS: int = 60 * 60 * 24 * 14  # 14 days
    BCRYPT_ROUNDS: int = 12

    # Email (Resend)
    RESEND_API_KEY: Optional[str] = None
    EMAIL_FROM: str = "noreply@sdmp.app"
    EMAIL_CONFIRM_BASE_URL: str = "http://localhost:3100"

    # CORS — strict allowlist; pipe-separated
    BACKEND_CORS_ORIGINS: str = "http://localhost:3100,http://localhost:8080,tauri://localhost"
    API_V1_PREFIX: str = "/api"
    LOG_LEVEL: str = "INFO"
    LOG_DIR: Path = Path("logs")

    # Public-DNS check defaults (no SSH; metadata-only)
    DNS_PRECHECK_ATTEMPTS: int = 10
    DNS_PRECHECK_DELAY: int = 15

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.BACKEND_CORS_ORIGINS.split(",") if o.strip()]


settings = Settings()


def _asyncpg_prepared_statement_name() -> str:
    return f"__asyncpg_{uuid.uuid4().hex}__"


ASYNCPG_CONNECT_ARGS: dict[str, object] = {
    "server_settings": {"statement_timeout": "60000"},
    "statement_cache_size": 0,
    "prepared_statement_cache_size": 0,
    "prepared_statement_name_func": _asyncpg_prepared_statement_name,
}
```

- [ ] **Step 2: Update `.env.example`**

Replace contents:

```
SUPABASE_DB_URL=postgresql+asyncpg://postgres.<project_ref>:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_KEY=<service-role-or-anon-key>
REDIS_URL=redis://redis:6379/0
CELERY_BROKER_URL=redis://redis:6379/1
CELERY_RESULT_BACKEND=redis://redis:6379/2

# Auth
SECRET_KEY=change_me_signed_cookie_secret
SESSION_COOKIE_NAME=sdmp_session
SESSION_TTL_SECONDS=1209600
BCRYPT_ROUNDS=12

# Email (Resend)
RESEND_API_KEY=
EMAIL_FROM=noreply@sdmp.app
EMAIL_CONFIRM_BASE_URL=http://localhost:3100

# CORS allowlist
BACKEND_CORS_ORIGINS=http://localhost:3100,http://localhost:8080,tauri://localhost
API_V1_PREFIX=/api
VITE_API_URL=http://localhost:8100/api
```

- [ ] **Step 3: Update `entrypoint.sh`**

`backend/entrypoint.sh` currently imports `ENCRYPTION_KEY` indirectly via `app.core.config`. After dropping the field, the existing wait-for-db logic still works — verify by running:

```bash
cd backend && python -c "from app.core.config import settings; print(settings.SECRET_KEY)"
```

Expected: prints whatever `SECRET_KEY` is in `.env`. If KeyError, ensure `.env` exists.

- [ ] **Step 4: Commit**

```bash
git add backend/app/core/config.py .env.example
git commit -m "chore(config): drop ENCRYPTION_KEY, add session/email/CORS settings"
```

---

## Task 3: Auth models

**Files:**
- Create: `backend/app/auth/__init__.py`
- Create: `backend/app/auth/models.py`
- Create: `backend/app/auth/schemas.py`

- [ ] **Step 1: Write `backend/app/auth/__init__.py`**

```python
```

(empty marker)

- [ ] **Step 2: Write `backend/app/auth/models.py`**

```python
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import LargeBinary, String, ForeignKey, DateTime, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    salt: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    auth_key_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    totp_secret: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    email_confirmed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    email_confirm_token_hash: Mapped[Optional[bytes]] = mapped_column(LargeBinary, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, unique=True, nullable=False)
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    user_agent: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class RecoveryBlob(Base):
    __tablename__ = "recovery_blob"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)


class SyncState(Base):
    __tablename__ = "sync_state"

    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    current_version: Mapped[int] = mapped_column(nullable=False, server_default=text("0"))
```

- [ ] **Step 3: Write `backend/app/auth/schemas.py`**

```python
from datetime import datetime
from typing import Optional
import uuid

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    salt_b64: str = Field(min_length=16, max_length=64)
    auth_key_b64: str = Field(min_length=32, max_length=128)
    recovery_blob_b64: str = Field(min_length=64, max_length=512)


class LoginStartRequest(BaseModel):
    email: EmailStr


class LoginStartResponse(BaseModel):
    salt_b64: str


class LoginFinishRequest(BaseModel):
    email: EmailStr
    auth_key_b64: str
    totp_code: Optional[str] = None


class UserMeResponse(BaseModel):
    id: uuid.UUID
    email: EmailStr
    email_confirmed_at: Optional[datetime] = None
    totp_enabled: bool


class ConfirmEmailRequest(BaseModel):
    token: str


class RecoveryStartRequest(BaseModel):
    email: EmailStr


class RecoveryStartResponse(BaseModel):
    salt_b64: str
    recovery_blob_b64: str


class RecoveryFinishRequest(BaseModel):
    email: EmailStr
    new_salt_b64: str
    new_auth_key_b64: str
    new_recovery_blob_b64: str


class ChangePasswordRequest(BaseModel):
    old_auth_key_b64: str
    new_salt_b64: str
    new_auth_key_b64: str
    re_encrypted_blobs: list[dict]  # [{id, ciphertext_b64, version_seen}]


class TotpEnableResponse(BaseModel):
    provisioning_uri: str
    secret: str  # plain TOTP secret, shown once


class TotpVerifyRequest(BaseModel):
    code: str
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/auth/
git commit -m "feat(auth): add User/Session/RecoveryBlob/SyncState models and schemas"
```

---

## Task 4: Crypto helpers (server side)

Server bcrypt-hashes the `auth_key` it receives over the wire (defense in depth: client-derived Argon2id auth_key + server-side bcrypt). Server also signs session tokens with `itsdangerous`.

**Files:**
- Create: `backend/app/auth/crypto.py`
- Test: `backend/tests/test_auth_crypto.py`

- [ ] **Step 1: Write the failing test**

`backend/tests/test_auth_crypto.py`:

```python
from app.auth.crypto import hash_auth_key, verify_auth_key, sign_session_token, parse_session_token
import time


def test_hash_and_verify_auth_key():
    key = b"a" * 32
    h = hash_auth_key(key)
    assert verify_auth_key(key, h)
    assert not verify_auth_key(b"b" * 32, h)


def test_session_token_roundtrip():
    user_id = "550e8400-e29b-41d4-a716-446655440000"
    token = sign_session_token(user_id)
    assert parse_session_token(token, max_age=60) == user_id


def test_session_token_expired():
    user_id = "550e8400-e29b-41d4-a716-446655440000"
    token = sign_session_token(user_id, _now=lambda: 0)
    # Pretend a lot of time has passed
    assert parse_session_token(token, max_age=1, _now=lambda: 9999) is None


def test_session_token_tampered():
    token = sign_session_token("a") + "x"
    assert parse_session_token(token, max_age=60) is None
```

Run, expect FAIL.

- [ ] **Step 2: Write `backend/app/auth/crypto.py`**

```python
import time
from typing import Callable, Optional

import bcrypt
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

from app.core.config import settings


_signer = TimestampSigner(settings.SECRET_KEY, salt="sdmp.session")


def hash_auth_key(auth_key: bytes) -> bytes:
    return bcrypt.hashpw(auth_key, bcrypt.gensalt(rounds=settings.BCRYPT_ROUNDS))


def verify_auth_key(auth_key: bytes, stored_hash: bytes) -> bool:
    try:
        return bcrypt.checkpw(auth_key, stored_hash)
    except ValueError:
        return False


def sign_session_token(user_id: str, _now: Callable[[], float] = time.time) -> str:
    # itsdangerous TimestampSigner uses internal time; tests inject via _now
    raw = user_id.encode("utf-8")
    signed = _signer.sign(raw)
    return signed.decode("utf-8")


def parse_session_token(
    token: str,
    *,
    max_age: int,
    _now: Callable[[], float] = time.time,
) -> Optional[str]:
    try:
        raw = _signer.unsign(token.encode("utf-8"), max_age=max_age)
        return raw.decode("utf-8")
    except (BadSignature, SignatureExpired):
        return None
```

Run test, expect PASS (note: `_now` injection isn't fully wired into `TimestampSigner`; if test 3 fails, stub by mocking `time.time` via `monkeypatch.setattr("itsdangerous.signer.time.time", lambda: 9999)` instead — adjust the test rather than the lib).

- [ ] **Step 3: Refine test 3 if needed**

Replace `test_session_token_expired` with:

```python
def test_session_token_expired(monkeypatch):
    user_id = "550e8400-e29b-41d4-a716-446655440000"
    monkeypatch.setattr("itsdangerous.timed.time.time", lambda: 0)
    token = sign_session_token(user_id)
    monkeypatch.setattr("itsdangerous.timed.time.time", lambda: 9999)
    assert parse_session_token(token, max_age=1) is None
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/auth/crypto.py backend/tests/test_auth_crypto.py
git commit -m "feat(auth): add bcrypt auth_key hashing and signed session tokens"
```

---

## Task 5: Email service

Resend HTTP API for confirmation and recovery emails. Falls back to logging when `RESEND_API_KEY` is empty (dev mode).

**Files:**
- Create: `backend/app/auth/email.py`
- Test: `backend/tests/test_auth_email.py`

- [ ] **Step 1: Write `backend/app/auth/email.py`**

```python
import logging
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)


async def send_confirmation_email(to_email: str, token: str) -> bool:
    confirm_url = f"{settings.EMAIL_CONFIRM_BASE_URL}/confirm-email?token={token}"
    subject = "Confirm your SDMP account"
    body = f"Click to confirm: {confirm_url}\n\nThis link expires in 24 hours."
    return await _send(to_email, subject, body)


async def send_recovery_email(to_email: str, token: str) -> bool:
    recover_url = f"{settings.EMAIL_CONFIRM_BASE_URL}/recover?token={token}"
    subject = "SDMP password recovery"
    body = (
        f"You requested a password recovery. Use this link with your BIP39 phrase:\n{recover_url}\n\n"
        "If you did not request this, ignore."
    )
    return await _send(to_email, subject, body)


async def _send(to_email: str, subject: str, body: str) -> bool:
    if not settings.RESEND_API_KEY:
        logger.info("DEV email (no API key): to=%s subject=%s\n%s", to_email, subject, body)
        return True
    headers = {"Authorization": f"Bearer {settings.RESEND_API_KEY}"}
    payload = {
        "from": settings.EMAIL_FROM,
        "to": [to_email],
        "subject": subject,
        "text": body,
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post("https://api.resend.com/emails", headers=headers, json=payload)
    if resp.status_code >= 400:
        logger.error("resend send failed: %s %s", resp.status_code, resp.text)
        return False
    return True
```

- [ ] **Step 2: Write `backend/tests/test_auth_email.py`**

```python
import logging

import pytest

from app.auth.email import send_confirmation_email
from app.core.config import settings


@pytest.mark.asyncio
async def test_send_falls_back_to_log_in_dev(monkeypatch, caplog):
    monkeypatch.setattr(settings, "RESEND_API_KEY", None)
    caplog.set_level(logging.INFO)
    ok = await send_confirmation_email("u@example.com", "tok123")
    assert ok
    assert any("u@example.com" in r.message for r in caplog.records)
```

Run, expect PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/app/auth/email.py backend/tests/test_auth_email.py
git commit -m "feat(auth): Resend-backed email service with dev log fallback"
```

---

## Task 6: Auth routes — register / login / logout / me

**Files:**
- Create: `backend/app/auth/routes.py`
- Create: `backend/app/auth/dependencies.py`
- Modify: `backend/app/api/routes/__init__.py` (mount auth router)
- Test: `backend/tests/test_auth_register_login.py`

- [ ] **Step 1: Write `backend/app/auth/dependencies.py`**

```python
import hashlib
from datetime import datetime, timezone
from typing import Optional
import uuid

from fastapi import Cookie, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.crypto import parse_session_token
from app.auth.models import Session, User
from app.core.config import settings
from app.core.database import get_db


async def get_current_user_or_401(
    request: Request,
    db: AsyncSession = Depends(get_db),
    session_cookie: Optional[str] = Cookie(default=None, alias=None),
) -> User:
    cookie_value = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if not cookie_value:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing session")
    user_id_str = parse_session_token(cookie_value, max_age=settings.SESSION_TTL_SECONDS)
    if user_id_str is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid session")
    token_hash = hashlib.sha256(cookie_value.encode("utf-8")).digest()
    sess = (await db.execute(select(Session).where(Session.token_hash == token_hash))).scalar_one_or_none()
    if sess is None or sess.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "session expired")
    user = await db.get(User, uuid.UUID(user_id_str))
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return user
```

- [ ] **Step 2: Write `backend/app/auth/routes.py`**

```python
import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
import uuid

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import schemas
from app.auth.crypto import hash_auth_key, sign_session_token, verify_auth_key
from app.auth.email import send_confirmation_email, send_recovery_email
from app.auth.dependencies import get_current_user_or_401
from app.auth.models import RecoveryBlob, Session as DbSession, User
from app.core.config import settings
from app.core.database import get_db

router = APIRouter(prefix="/auth", tags=["auth"])


def _b64decode(s: str) -> bytes:
    return base64.b64decode(s.encode("utf-8"))


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.SESSION_COOKIE_NAME,
        value=token,
        max_age=settings.SESSION_TTL_SECONDS,
        httponly=True,
        secure=False,  # set True in production behind TLS
        samesite="strict",
    )


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    body: schemas.RegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    existing = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "email already registered")
    salt = _b64decode(body.salt_b64)
    auth_key = _b64decode(body.auth_key_b64)
    recovery_blob = _b64decode(body.recovery_blob_b64)
    confirm_token = secrets.token_urlsafe(32)
    user = User(
        email=body.email,
        salt=salt,
        auth_key_hash=hash_auth_key(auth_key),
        email_confirm_token_hash=hashlib.sha256(confirm_token.encode("utf-8")).digest(),
    )
    db.add(user)
    await db.flush()
    db.add(RecoveryBlob(user_id=user.id, ciphertext=recovery_blob))
    await db.commit()
    await send_confirmation_email(body.email, confirm_token)
    return {"user_id": str(user.id)}


@router.post("/confirm-email", status_code=status.HTTP_200_OK)
async def confirm_email(
    body: schemas.ConfirmEmailRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    token_hash = hashlib.sha256(body.token.encode("utf-8")).digest()
    user = (await db.execute(select(User).where(User.email_confirm_token_hash == token_hash))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid or expired token")
    user.email_confirmed_at = datetime.now(timezone.utc)
    user.email_confirm_token_hash = None
    await db.commit()
    return {"ok": True}


@router.post("/login/start", response_model=schemas.LoginStartResponse)
async def login_start(
    body: schemas.LoginStartRequest,
    db: AsyncSession = Depends(get_db),
) -> schemas.LoginStartResponse:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    # Always return a salt to avoid email enumeration; use a deterministic dummy if not found
    if user is None:
        dummy = hashlib.sha256(body.email.lower().encode("utf-8")).digest()[:16]
        return schemas.LoginStartResponse(salt_b64=base64.b64encode(dummy).decode())
    return schemas.LoginStartResponse(salt_b64=base64.b64encode(user.salt).decode())


@router.post("/login/finish")
async def login_finish(
    body: schemas.LoginFinishRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> dict:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    if not verify_auth_key(_b64decode(body.auth_key_b64), user.auth_key_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid credentials")
    if user.totp_secret:
        if not body.totp_code or not pyotp.TOTP(user.totp_secret).verify(body.totp_code, valid_window=1):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid TOTP code")
    if user.email_confirmed_at is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "email not confirmed")
    token = sign_session_token(str(user.id))
    expires = datetime.now(timezone.utc) + timedelta(seconds=settings.SESSION_TTL_SECONDS)
    db.add(DbSession(
        user_id=user.id,
        token_hash=hashlib.sha256(token.encode("utf-8")).digest(),
        ip=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:255],
        expires_at=expires,
    ))
    await db.commit()
    _set_session_cookie(response, token)
    return {"user_id": str(user.id)}


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> None:
    cookie_value = request.cookies.get(settings.SESSION_COOKIE_NAME)
    if cookie_value:
        token_hash = hashlib.sha256(cookie_value.encode("utf-8")).digest()
        sess = (await db.execute(select(DbSession).where(DbSession.token_hash == token_hash))).scalar_one_or_none()
        if sess is not None:
            await db.delete(sess)
            await db.commit()
    response.delete_cookie(settings.SESSION_COOKIE_NAME)


@router.get("/me", response_model=schemas.UserMeResponse)
async def me(user: User = Depends(get_current_user_or_401)) -> schemas.UserMeResponse:
    return schemas.UserMeResponse(
        id=user.id,
        email=user.email,
        email_confirmed_at=user.email_confirmed_at,
        totp_enabled=user.totp_secret is not None,
    )
```

- [ ] **Step 3: Mount router in `backend/app/api/routes/__init__.py`**

Add to the api_router includes:

```python
from app.auth.routes import router as auth_router

api_router.include_router(auth_router)
```

- [ ] **Step 4: Write `backend/tests/test_auth_register_login.py`**

```python
import base64
import pytest
from httpx import AsyncClient, ASGITransport

from app.main import app


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


@pytest.mark.asyncio
async def test_register_login_me_logout_flow():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.post("/api/auth/register", json={
            "email": "alice@example.com",
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
        })
        assert r.status_code == 201

        # Confirm by reading the token from logs is impossible in test; manually mark confirmed
        # via DB for the test (in real flow, click the email link).
        from app.core.database import AsyncSessionLocal
        from app.auth.models import User
        from sqlalchemy import select, update
        from datetime import datetime, timezone
        async with AsyncSessionLocal() as s:
            await s.execute(update(User).where(User.email == "alice@example.com").values(
                email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None,
            ))
            await s.commit()

        r = await c.post("/api/auth/login/start", json={"email": "alice@example.com"})
        assert r.status_code == 200
        assert "salt_b64" in r.json()

        r = await c.post("/api/auth/login/finish", json={
            "email": "alice@example.com",
            "auth_key_b64": b64(b"\x01" * 32),
        })
        assert r.status_code == 200, r.text

        r = await c.get("/api/auth/me")
        assert r.status_code == 200
        assert r.json()["email"] == "alice@example.com"

        r = await c.post("/api/auth/logout")
        assert r.status_code == 204

        r = await c.get("/api/auth/me")
        assert r.status_code == 401


@pytest.mark.asyncio
async def test_register_duplicate_email_returns_409():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        body = {
            "email": "dup@example.com",
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
        }
        r1 = await c.post("/api/auth/register", json=body)
        assert r1.status_code in (201, 409)
        r2 = await c.post("/api/auth/register", json=body)
        assert r2.status_code == 409


@pytest.mark.asyncio
async def test_login_finish_wrong_password_returns_401():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await c.post("/api/auth/register", json={
            "email": "bob@example.com",
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
        })
        r = await c.post("/api/auth/login/finish", json={
            "email": "bob@example.com",
            "auth_key_b64": b64(b"\x99" * 32),
        })
        assert r.status_code == 401
```

Run: `cd backend && pytest tests/test_auth_register_login.py -v`. Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/app/auth/routes.py backend/app/auth/dependencies.py backend/app/api/routes/__init__.py backend/tests/test_auth_register_login.py
git commit -m "feat(auth): register, login start/finish, me, logout endpoints"
```

---

## Task 7: Recovery flow + password change

**Files:**
- Modify: `backend/app/auth/routes.py` (append routes)
- Test: `backend/tests/test_auth_recovery.py`

- [ ] **Step 1: Append to `backend/app/auth/routes.py`**

```python
@router.post("/recovery/start", response_model=schemas.RecoveryStartResponse)
async def recovery_start(
    body: schemas.RecoveryStartRequest,
    db: AsyncSession = Depends(get_db),
) -> schemas.RecoveryStartResponse:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user is None:
        # Avoid enumeration: return random-looking salt + dummy blob
        return schemas.RecoveryStartResponse(
            salt_b64=base64.b64encode(secrets.token_bytes(16)).decode(),
            recovery_blob_b64=base64.b64encode(secrets.token_bytes(96)).decode(),
        )
    rb = await db.get(RecoveryBlob, user.id)
    if rb is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "recovery not configured")
    return schemas.RecoveryStartResponse(
        salt_b64=base64.b64encode(user.salt).decode(),
        recovery_blob_b64=base64.b64encode(rb.ciphertext).decode(),
    )


@router.post("/recovery/finish", status_code=status.HTTP_200_OK)
async def recovery_finish(
    body: schemas.RecoveryFinishRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    user = (await db.execute(select(User).where(User.email == body.email))).scalar_one_or_none()
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    user.salt = _b64decode(body.new_salt_b64)
    user.auth_key_hash = hash_auth_key(_b64decode(body.new_auth_key_b64))
    rb = await db.get(RecoveryBlob, user.id)
    if rb is None:
        rb = RecoveryBlob(user_id=user.id, ciphertext=_b64decode(body.new_recovery_blob_b64))
        db.add(rb)
    else:
        rb.ciphertext = _b64decode(body.new_recovery_blob_b64)
    # invalidate all existing sessions
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(DbSession).where(DbSession.user_id == user.id))
    await db.commit()
    return {"ok": True}


@router.post("/password/change", status_code=status.HTTP_200_OK)
async def change_password(
    body: schemas.ChangePasswordRequest,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not verify_auth_key(_b64decode(body.old_auth_key_b64), user.auth_key_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid current password")
    user.salt = _b64decode(body.new_salt_b64)
    user.auth_key_hash = hash_auth_key(_b64decode(body.new_auth_key_b64))
    # apply re-encrypted blobs (handled by sync upload in practice; here we trust client)
    from app.blobs.models import BlobStorage  # imported lazily; module added in Task 17
    for entry in body.re_encrypted_blobs:
        blob = await db.get(BlobStorage, uuid.UUID(entry["id"]))
        if blob is None or blob.user_id != user.id:
            continue
        blob.ciphertext = _b64decode(entry["ciphertext_b64"])
        # version bump handled by sync layer; for now leave server version for next push
    await db.commit()
    return {"ok": True}
```

- [ ] **Step 2: Write `backend/tests/test_auth_recovery.py`**

```python
import base64
import pytest
from datetime import datetime, timezone
from httpx import AsyncClient, ASGITransport
from sqlalchemy import update

from app.main import app
from app.core.database import AsyncSessionLocal
from app.auth.models import User


def b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


@pytest.mark.asyncio
async def test_recovery_changes_master_password():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await c.post("/api/auth/register", json={
            "email": "rec@example.com",
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
        })
        async with AsyncSessionLocal() as s:
            await s.execute(update(User).where(User.email == "rec@example.com").values(
                email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None,
            ))
            await s.commit()

        # Lose old password, recover with phrase
        r = await c.post("/api/auth/recovery/start", json={"email": "rec@example.com"})
        assert r.status_code == 200
        # client side decrypts recovery_blob with BIP39 phrase, derives new master key,
        # re-wraps recovery, computes new auth_key. Test simulates this:
        r = await c.post("/api/auth/recovery/finish", json={
            "email": "rec@example.com",
            "new_salt_b64": b64(b"\x10" * 16),
            "new_auth_key_b64": b64(b"\x11" * 32),
            "new_recovery_blob_b64": b64(b"\x12" * 96),
        })
        assert r.status_code == 200

        # Old password must fail
        r = await c.post("/api/auth/login/finish", json={
            "email": "rec@example.com",
            "auth_key_b64": b64(b"\x01" * 32),
        })
        assert r.status_code == 401

        # New password works
        r = await c.post("/api/auth/login/finish", json={
            "email": "rec@example.com",
            "auth_key_b64": b64(b"\x11" * 32),
        })
        assert r.status_code == 200
```

Run: `pytest tests/test_auth_recovery.py -v`. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/app/auth/routes.py backend/tests/test_auth_recovery.py
git commit -m "feat(auth): BIP39 recovery flow + master password change"
```

---

## Task 8: TOTP enable / verify

**Files:**
- Modify: `backend/app/auth/routes.py` (append)
- Test: `backend/tests/test_auth_totp.py`

- [ ] **Step 1: Append routes**

```python
@router.post("/totp/enable", response_model=schemas.TotpEnableResponse)
async def totp_enable(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> schemas.TotpEnableResponse:
    if user.totp_secret:
        raise HTTPException(status.HTTP_409_CONFLICT, "totp already enabled")
    secret = pyotp.random_base32()
    user.totp_secret = secret
    await db.commit()
    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name="SDMP")
    return schemas.TotpEnableResponse(provisioning_uri=uri, secret=secret)


@router.post("/totp/verify", status_code=status.HTTP_200_OK)
async def totp_verify(
    body: schemas.TotpVerifyRequest,
    user: User = Depends(get_current_user_or_401),
) -> dict:
    if not user.totp_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "totp not enabled")
    ok = pyotp.TOTP(user.totp_secret).verify(body.code, valid_window=1)
    return {"ok": ok}
```

- [ ] **Step 2: Test**

`backend/tests/test_auth_totp.py`:

```python
import base64, pytest, pyotp
from datetime import datetime, timezone
from httpx import AsyncClient, ASGITransport
from sqlalchemy import update
from app.main import app
from app.core.database import AsyncSessionLocal
from app.auth.models import User


def b64(b): return base64.b64encode(b).decode()


@pytest.mark.asyncio
async def test_totp_enable_and_login_with_code():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await c.post("/api/auth/register", json={
            "email": "totp@example.com",
            "salt_b64": b64(b"\x00" * 16),
            "auth_key_b64": b64(b"\x01" * 32),
            "recovery_blob_b64": b64(b"\x02" * 96),
        })
        async with AsyncSessionLocal() as s:
            await s.execute(update(User).where(User.email == "totp@example.com").values(
                email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None,
            ))
            await s.commit()
        await c.post("/api/auth/login/finish", json={
            "email": "totp@example.com",
            "auth_key_b64": b64(b"\x01" * 32),
        })
        r = await c.post("/api/auth/totp/enable")
        assert r.status_code == 200
        secret = r.json()["secret"]
        # next login requires totp
        await c.post("/api/auth/logout")
        r = await c.post("/api/auth/login/finish", json={
            "email": "totp@example.com",
            "auth_key_b64": b64(b"\x01" * 32),
        })
        assert r.status_code == 401
        code = pyotp.TOTP(secret).now()
        r = await c.post("/api/auth/login/finish", json={
            "email": "totp@example.com",
            "auth_key_b64": b64(b"\x01" * 32),
            "totp_code": code,
        })
        assert r.status_code == 200
```

Run, expect PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/app/auth/routes.py backend/tests/test_auth_totp.py
git commit -m "feat(auth): TOTP enable + verify on login"
```

---

## Task 9: Blob storage module

**Files:**
- Create: `backend/app/blobs/__init__.py`
- Create: `backend/app/blobs/models.py`
- Create: `backend/app/blobs/schemas.py`
- Create: `backend/app/blobs/routes.py`
- Test: `backend/tests/test_blobs.py`

- [ ] **Step 1: Models**

`backend/app/blobs/models.py`:

```python
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, BigInteger, DateTime, ForeignKey, LargeBinary, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class BlobStorage(Base):
    __tablename__ = "blob_storage"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    blob_kind: Mapped[str] = mapped_column(String(64), nullable=False)
    version: Mapped[int] = mapped_column(BigInteger, nullable=False)
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
    deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
```

- [ ] **Step 2: Schemas**

`backend/app/blobs/schemas.py`:

```python
import uuid
from datetime import datetime
from pydantic import BaseModel, Field


class BlobUpsert(BaseModel):
    blob_kind: str = Field(min_length=1, max_length=64)
    ciphertext_b64: str
    device_id: uuid.UUID | None = None


class BlobResponse(BaseModel):
    id: uuid.UUID
    blob_kind: str
    ciphertext_b64: str
    version: int
    updated_at: datetime
    deleted: bool
```

- [ ] **Step 3: Routes**

`backend/app/blobs/routes.py`:

```python
import base64
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.blobs.models import BlobStorage
from app.blobs.schemas import BlobResponse, BlobUpsert
from app.core.database import get_db
from app.sync.service import bump_version

router = APIRouter(prefix="/blobs", tags=["blobs"])

MAX_BLOB_BYTES = 64 * 1024


def _to_response(b: BlobStorage) -> BlobResponse:
    return BlobResponse(
        id=b.id,
        blob_kind=b.blob_kind,
        ciphertext_b64=base64.b64encode(b.ciphertext).decode(),
        version=b.version,
        updated_at=b.updated_at,
        deleted=b.deleted,
    )


@router.put("/{blob_id}", response_model=BlobResponse)
async def upsert_blob(
    blob_id: uuid.UUID,
    body: BlobUpsert,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> BlobResponse:
    raw = base64.b64decode(body.ciphertext_b64.encode())
    if len(raw) > MAX_BLOB_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"blob > {MAX_BLOB_BYTES} bytes")
    existing = await db.get(BlobStorage, blob_id)
    new_version = await bump_version(db, user.id)
    if existing is None:
        b = BlobStorage(
            id=blob_id,
            user_id=user.id,
            ciphertext=raw,
            blob_kind=body.blob_kind,
            version=new_version,
            device_id=body.device_id,
            updated_at=datetime.now(timezone.utc),
            deleted=False,
        )
        db.add(b)
    else:
        if existing.user_id != user.id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
        existing.ciphertext = raw
        existing.blob_kind = body.blob_kind
        existing.version = new_version
        existing.device_id = body.device_id
        existing.updated_at = datetime.now(timezone.utc)
        existing.deleted = False
        b = existing
    await db.commit()
    await db.refresh(b)
    return _to_response(b)


@router.get("/{blob_id}", response_model=BlobResponse)
async def get_blob(
    blob_id: uuid.UUID,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> BlobResponse:
    b = await db.get(BlobStorage, blob_id)
    if b is None or b.user_id != user.id or b.deleted:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    return _to_response(b)


@router.delete("/{blob_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_blob(
    blob_id: uuid.UUID,
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> None:
    b = await db.get(BlobStorage, blob_id)
    if b is None or b.user_id != user.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "not found")
    new_version = await bump_version(db, user.id)
    b.deleted = True
    b.version = new_version
    b.updated_at = datetime.now(timezone.utc)
    await db.commit()
```

- [ ] **Step 4: Test ownership enforcement and size limits**

`backend/tests/test_blobs.py` — register two users, ensure user A cannot read/write user B's blob, ensure 64 KiB limit returns 413, ensure delete is soft and reflects in subsequent GET. (Pattern: same `AsyncClient` setup as Task 6.)

- [ ] **Step 5: Mount router and commit**

Add `from app.blobs.routes import router as blobs_router` and `api_router.include_router(blobs_router)` in `backend/app/api/routes/__init__.py`.

```bash
git add backend/app/blobs/ backend/tests/test_blobs.py backend/app/api/routes/__init__.py
git commit -m "feat(blobs): opaque blob CRUD with per-user ownership and 64KiB limit"
```

---

## Task 10: Sync state + sync API

**Files:**
- Create: `backend/app/sync/__init__.py`
- Create: `backend/app/sync/service.py`
- Create: `backend/app/sync/routes.py`
- Create: `backend/app/sync/schemas.py`
- Test: `backend/tests/test_sync.py`

- [ ] **Step 1: Service**

`backend/app/sync/service.py`:

```python
import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import SyncState


async def bump_version(db: AsyncSession, user_id: uuid.UUID) -> int:
    state = await db.get(SyncState, user_id, with_for_update=True)
    if state is None:
        state = SyncState(user_id=user_id, current_version=1)
        db.add(state)
        await db.flush()
        return 1
    state.current_version += 1
    await db.flush()
    return state.current_version


async def current_version(db: AsyncSession, user_id: uuid.UUID) -> int:
    state = await db.get(SyncState, user_id)
    return state.current_version if state else 0
```

- [ ] **Step 2: Schemas**

`backend/app/sync/schemas.py`:

```python
from typing import Any
from pydantic import BaseModel


class ChangeRow(BaseModel):
    table: str
    id: str
    version: int
    deleted: bool
    fields: dict[str, Any] | None = None  # null when deleted


class SyncChangesResponse(BaseModel):
    version: int
    rows: list[ChangeRow]
    blob_ids: list[str]  # ids whose version > since; client GETs each


class SyncSnapshotResponse(BaseModel):
    version: int
    rows: list[ChangeRow]
    blob_ids: list[str]
```

- [ ] **Step 3: Routes**

`backend/app/sync/routes.py`:

```python
from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User
from app.blobs.models import BlobStorage
from app.core.database import get_db
from app.sync import schemas
from app.sync.service import current_version
from app.models.domain import Domain
from app.models.server import Server
from app.models.cloudflare_account import CloudflareAccount
from app.models.registrar_account import RegistrarAccount
from app.models.notification import Notification
from app.models.task_log import TaskLog
from app.models.system_config import SystemConfig
from app.models.activity_log import ActivityLog

router = APIRouter(prefix="/sync", tags=["sync"])


SCOPED_MODELS = {
    "domains": Domain,
    "servers": Server,
    "cloudflare_accounts": CloudflareAccount,
    "registrar_accounts": RegistrarAccount,
    "notifications": Notification,
    "task_logs": TaskLog,
    "system_config": SystemConfig,
    "activity_logs": ActivityLog,
}


def _to_row(table: str, obj) -> schemas.ChangeRow:
    fields = None if obj.sync_deleted else {
        c.name: getattr(obj, c.name) for c in obj.__table__.columns
        if c.name not in {"sync_version", "sync_deleted", "user_id"}
    }
    return schemas.ChangeRow(table=table, id=str(obj.id), version=obj.sync_version, deleted=obj.sync_deleted, fields=fields)


@router.get("/snapshot", response_model=schemas.SyncSnapshotResponse)
async def snapshot(
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> schemas.SyncSnapshotResponse:
    rows: list[schemas.ChangeRow] = []
    for table, model in SCOPED_MODELS.items():
        result = await db.execute(select(model).where(model.user_id == user.id))
        for obj in result.scalars().all():
            rows.append(_to_row(table, obj))
    blob_ids = [
        str(b.id) for b in (await db.execute(select(BlobStorage).where(BlobStorage.user_id == user.id))).scalars().all()
    ]
    return schemas.SyncSnapshotResponse(
        version=await current_version(db, user.id),
        rows=rows,
        blob_ids=blob_ids,
    )


@router.get("/changes", response_model=schemas.SyncChangesResponse)
async def changes(
    since: int = Query(0, ge=0),
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> schemas.SyncChangesResponse:
    rows: list[schemas.ChangeRow] = []
    for table, model in SCOPED_MODELS.items():
        result = await db.execute(select(model).where(model.user_id == user.id, model.sync_version > since))
        for obj in result.scalars().all():
            rows.append(_to_row(table, obj))
    blob_ids = [
        str(b.id) for b in (await db.execute(
            select(BlobStorage).where(BlobStorage.user_id == user.id, BlobStorage.version > since)
        )).scalars().all()
    ]
    return schemas.SyncChangesResponse(
        version=await current_version(db, user.id),
        rows=rows,
        blob_ids=blob_ids,
    )
```

(Note: The mutation upload endpoint isn't here — we let clients call existing CRUD endpoints to mutate metadata, and the sync API is read-side. This is simpler than a generic mutation upload and fits the existing route structure. Conflict detection happens via `version_seen` parameter in the existing PUT routes — added in Task 11.)

- [ ] **Step 4: Test**

`backend/tests/test_sync.py` covers: empty snapshot, after creating a domain via existing PUT, snapshot includes it; incremental `since=N` returns only changes after N; user A cannot see user B's rows.

- [ ] **Step 5: Commit**

```bash
git add backend/app/sync/ backend/tests/test_sync.py backend/app/api/routes/__init__.py
git commit -m "feat(sync): per-user snapshot and incremental changes endpoints"
```

---

## Task 11: Apply auth + user-scope to existing routes

For every kept endpoint, add `Depends(get_current_user_or_401)` and scope queries by `user_id`. Implementation note: extend each service to accept `user: User` and filter with `where(model.user_id == user.id)`.

**Files:**
- Modify: `backend/app/api/routes/domains.py` (add auth, scope)
- Modify: `backend/app/api/routes/servers.py` (add auth, scope)
- Modify: `backend/app/api/routes/cloudflare.py` (add auth, scope)
- Modify: `backend/app/api/routes/registrars.py` (add auth, scope)
- Modify: `backend/app/api/routes/notifications.py` (add auth, scope)
- Modify: `backend/app/api/routes/settings.py` (add auth, scope)
- Modify: `backend/app/api/routes/tasks.py` (add auth, scope)
- Modify: `backend/app/api/routes/ssl_emails.py` (add auth, scope)
- Modify: `backend/app/services/domain_service.py`, `server_service.py`, `notification_service.py`, `system_config_service.py` (accept user.id, filter)
- Test: `backend/tests/test_user_scoping.py`

- [ ] **Step 1: Pattern for each route**

Example for `domains.py` — apply same pattern to all kept endpoints:

```python
from app.auth.dependencies import get_current_user_or_401
from app.auth.models import User

@router.get("", response_model=list[DomainResponse])
async def list_domains(
    server_id: Optional[int] = Query(None),
    user: User = Depends(get_current_user_or_401),
    db: AsyncSession = Depends(get_db),
) -> list[DomainResponse]:
    items = await domain_service.get_all(db, user_id=user.id, server_id=server_id, ...)
    return [DomainResponse.model_validate(d) for d in items]
```

In each service, add `user_id: uuid.UUID` parameter and filter every query:

```python
async def get_all(db: AsyncSession, *, user_id: uuid.UUID, ...) -> list[Domain]:
    stmt = select(Domain).where(Domain.user_id == user_id)
    ...
```

For `create()` calls, set `domain.user_id = user_id` before `db.add()`. For `update()`/`delete()`/`get_by_id()`, ensure ownership: load by id, then assert `obj.user_id == user_id`, else raise 404.

- [ ] **Step 2: Apply to all routes/services**

Make the change file-by-file. For each route file, run the file's tests after changes. Commit per-file:

```bash
git add backend/app/api/routes/domains.py backend/app/services/domain_service.py
git commit -m "refactor(domains): require auth and scope queries by user_id"
# repeat for each route
```

- [ ] **Step 3: Test cross-tenant isolation**

`backend/tests/test_user_scoping.py`:

```python
import base64, pytest
from datetime import datetime, timezone
from httpx import AsyncClient, ASGITransport
from sqlalchemy import update
from app.main import app
from app.core.database import AsyncSessionLocal
from app.auth.models import User


def b64(b): return base64.b64encode(b).decode()


async def _register_and_login(client, email, key=b"\x01" * 32):
    await client.post("/api/auth/register", json={
        "email": email, "salt_b64": b64(b"\x00" * 16),
        "auth_key_b64": b64(key), "recovery_blob_b64": b64(b"\x02" * 96),
    })
    async with AsyncSessionLocal() as s:
        await s.execute(update(User).where(User.email == email).values(
            email_confirmed_at=datetime.now(timezone.utc), email_confirm_token_hash=None,
        ))
        await s.commit()
    await client.post("/api/auth/login/finish", json={
        "email": email, "auth_key_b64": b64(key),
    })


@pytest.mark.asyncio
async def test_user_a_cannot_see_user_b_domains():
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        await _register_and_login(c, "a@example.com")
        r = await c.post("/api/domains", json={"domain_name": "alice-only.com"})
        assert r.status_code == 201
        a_domain_id = r.json()["id"]
        await c.post("/api/auth/logout")
        await _register_and_login(c, "b@example.com", key=b"\x99" * 32)
        r = await c.get("/api/domains")
        assert r.status_code == 200
        for item in r.json():
            assert item["id"] != a_domain_id
        # Direct fetch returns 404, not 403, to avoid existence leak
        r = await c.get(f"/api/domains/{a_domain_id}")
        assert r.status_code == 404
```

Run, expect PASS.

- [ ] **Step 4: Commit**

After all routes converted:

```bash
git commit -m "test(scoping): verify cross-tenant isolation across all kept endpoints"
```

---

## Task 12: Delete SSH/encryption services and tasks

**Files to delete:**
- `backend/app/services/encryption_service.py`
- `backend/app/services/fastpanel_client.py`
- `backend/app/services/fastpanel_browser.py`
- `backend/app/services/cloudflare_service.py`
- `backend/app/services/server_metrics_service.py`
- `backend/app/services/temp_mail_service.py`
- `backend/app/services/ssl_email_service.py`
- `backend/app/services/registrars/`
- `backend/app/tasks/provision_task.py`
- `backend/app/tasks/fastpanel_task.py`
- `backend/app/tasks/ssl_request_task.py`
- `backend/app/tasks/ssl_refresh_task.py`
- `backend/app/tasks/revoke_ssl_task.py`
- `backend/app/tasks/nginx_override_task.py`
- `backend/app/tasks/create_db_task.py`
- `backend/app/tasks/check_ns_task.py`
- `backend/app/tasks/ns_task.py`
- `backend/app/tasks/bulk_full_setup_task.py`

**Files to modify (remove SSH-touching endpoints/methods):**
- `backend/app/api/routes/domains.py` — remove `/provision`, `/create-site`, `/bulk-provision`, `/bulk-full-setup`, `/create-db`, `/ssl-*`, `/refresh-ssl`, `/nginx-override` (POST), `/check-ns`, `/set-ns`, `/bulk-set-ns`, `/mark-ns-set`, related imports
- `backend/app/api/routes/servers.py` — remove `/test-ssh`, `/refresh-metrics`, `/refresh-uptime`, `/sync-domains`, `/install-fastpanel`, `/fastpanel-status`
- `backend/app/api/routes/cloudflare.py` — remove zone/DNS endpoints
- `backend/app/api/routes/registrars.py` — remove test/list/set-ns endpoints
- `backend/app/services/server_service.py` — remove SSH-touching methods (`test_ssh_connection`, `fetch_and_persist_metrics`, `fetch_and_persist_domains`)
- `backend/app/tasks/server_health_task.py` — remove SSH portion; keep only DNS/metadata checks if any
- `backend/app/core/celery_app.py` — remove imports of deleted tasks; keep only `renewal_task`

- [ ] **Step 1: Delete files**

```bash
cd backend/app
rm services/encryption_service.py services/fastpanel_client.py services/fastpanel_browser.py
rm services/cloudflare_service.py services/server_metrics_service.py
rm services/temp_mail_service.py services/ssl_email_service.py
rm -rf services/registrars/
rm tasks/provision_task.py tasks/fastpanel_task.py tasks/ssl_request_task.py
rm tasks/ssl_refresh_task.py tasks/revoke_ssl_task.py tasks/nginx_override_task.py
rm tasks/create_db_task.py tasks/check_ns_task.py tasks/ns_task.py tasks/bulk_full_setup_task.py
cd ..
rm tests/test_fastpanel_client.py tests/test_fastpanel_list_sites.py
rm tests/test_server_metrics_service.py tests/test_server_service_domains_sync.py
rm tests/test_bulk_full_setup_task.py
```

- [ ] **Step 2: Strip imports and removed endpoints from `domains.py`, `servers.py`, `cloudflare.py`, `registrars.py`**

Use `grep -n "from app.tasks\|from app.services.fastpanel\|from app.services.encryption\|from app.services.registrars" backend/app/api/routes/*.py` to find every dead import; remove. Remove every endpoint that references a deleted module.

For `cloudflare.py` and `registrars.py`, **keep account CRUD only** (token/key now stored as blob_id reference); remove all execute methods.

- [ ] **Step 3: Run backend tests, expect all green**

```bash
cd backend && pytest -v
```

Expected: all remaining tests pass; no import errors. Fix any ImportError until clean.

- [ ] **Step 4: Confirm no `paramiko` / `AutoAddPolicy` / `decrypt` / `ENCRYPTION_KEY` in backend**

```bash
grep -rn "paramiko\|AutoAddPolicy\|encryption_service\|ENCRYPTION_KEY" backend/app
```

Expected: zero matches. If matches found, remove them.

- [ ] **Step 5: Commit**

```bash
git add -A backend/
git commit -m "refactor: delete server-side SSH/encryption services and execution endpoints"
```

---

## Task 13: Audit log

**Files:**
- Create: `backend/app/audit/__init__.py`
- Create: `backend/app/audit/models.py`
- Create: `backend/app/audit/service.py`
- Create: `backend/app/audit/routes.py`
- Test: `backend/tests/test_audit.py`

- [ ] **Step 1: Model**

`backend/app/audit/models.py`:

```python
import uuid
from datetime import datetime
from typing import Optional, Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, text
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    target_type: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    target_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    device_id: Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), nullable=True)
    ip: Mapped[Optional[str]] = mapped_column(String(45), nullable=True)
    metadata: Mapped[Optional[dict[str, Any]]] = mapped_column(JSONB, nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"), nullable=False)
```

- [ ] **Step 2: Service + route**

`backend/app/audit/service.py`:

```python
import uuid
from typing import Optional, Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditLog


SAFE_ACTIONS = {
    "domain.create", "domain.update", "domain.delete",
    "server.create", "server.update", "server.delete",
    "cf.account.create", "cf.account.update", "cf.account.delete",
    "registrar.account.create", "registrar.account.update", "registrar.account.delete",
    "device.action.start", "device.action.complete", "device.action.fail",
    "auth.login", "auth.logout", "auth.password_change", "auth.recovery", "auth.totp_enable",
}


async def log(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    action: str,
    target_type: Optional[str] = None,
    target_id: Optional[str] = None,
    device_id: Optional[uuid.UUID] = None,
    ip: Optional[str] = None,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    if action not in SAFE_ACTIONS:
        raise ValueError(f"unknown audit action: {action}")
    db.add(AuditLog(
        user_id=user_id, action=action,
        target_type=target_type, target_id=target_id,
        device_id=device_id, ip=ip, metadata=metadata,
    ))
```

`backend/app/audit/routes.py` — exposes a `POST /audit/log` endpoint for the desktop client to push device-action events, and a `GET /audit/log` to read recent entries scoped to user.

- [ ] **Step 3: Plug audit into auth and CRUD routes**

In `auth/routes.py` login/logout/recovery: call `await audit_service.log(db, user_id=user.id, action="auth.login", ...)`. In domains/servers create/update/delete: same.

- [ ] **Step 4: Test**

`backend/tests/test_audit.py` — register, login, create domain, GET `/api/audit/log`, expect entries `auth.login` and `domain.create`. Verify no plaintext secrets appear in `metadata` (assert no key contains "password" / "token").

- [ ] **Step 5: Commit**

```bash
git add backend/app/audit/ backend/tests/test_audit.py
git commit -m "feat(audit): add audit log model, service, route + plug into auth and CRUD"
```

---

## Task 14: Rate limiting + CORS lockdown

**Files:**
- Modify: `backend/app/main.py`
- Test: `backend/tests/test_rate_limit.py`

- [ ] **Step 1: Configure slowapi in `main.py`**

Add to `backend/app/main.py`:

```python
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, storage_uri=settings.REDIS_URL)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
```

In `auth/routes.py`, decorate sensitive endpoints:

```python
from app.main import limiter

@router.post("/login/finish")
@limiter.limit("10/minute")
async def login_finish(request: Request, ...):
    ...
```

(Use `request: Request` parameter; required by slowapi.)

- [ ] **Step 2: CORS lockdown**

Edit `main.py` `add_middleware(CORSMiddleware, ...)`:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-CSRF-Token"],
)
```

(Strict allowlist replaces `["*"]`.)

- [ ] **Step 3: Test**

`backend/tests/test_rate_limit.py` — fire 11 login attempts in quick succession, expect 11th returns 429.

- [ ] **Step 4: Commit**

```bash
git add backend/app/main.py backend/app/auth/routes.py backend/tests/test_rate_limit.py
git commit -m "feat(security): rate-limit auth endpoints + lock CORS to allowlist"
```

---

## Stage 1 verification

```bash
cd backend
pytest -v
# Expected: all green, including:
# - test_lifespan
# - test_migration_011
# - test_auth_crypto, test_auth_email, test_auth_register_login
# - test_auth_recovery, test_auth_totp
# - test_blobs, test_sync, test_user_scoping
# - test_audit, test_rate_limit

grep -rn "paramiko\|AutoAddPolicy\|encryption_service\|ENCRYPTION_KEY\|fastpanel_client" backend/app
# Expected: zero matches

# Manual smoke
uvicorn app.main:app --port 8100 &
PID=$!
curl -X POST http://localhost:8100/api/auth/register -H "Content-Type: application/json" -d '{
  "email": "smoke@example.com",
  "salt_b64": "AAAAAAAAAAAAAAAAAAAAAA==",
  "auth_key_b64": "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
  "recovery_blob_b64": "AgIC..."
}'
# Expected: 201 with user_id
kill $PID
```

Stage 1 is complete when:
- All backend tests green.
- Server-side execution code grepped to zero.
- Migration 011 applies cleanly to a fresh DB.
- Auth, sync, and blob endpoints all functional via curl.
- Cross-tenant isolation verified by `test_user_scoping.py`.

Move to [Stage 2](./2026-05-06-stage-2-tauri-crypto-sync-client.md).
