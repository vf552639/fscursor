"""zero-knowledge v1: add users, sessions, blobs, scope existing tables

Revision ID: 011_zero_knowledge_v1
Revises: 010_domain_extras
Create Date: 2026-05-06

"""

from typing import Optional, Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "011_zero_knowledge_v1"
down_revision: Optional[str] = "010_domain_extras"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


SCOPED_TABLES = (
    "domains",
    "servers",
    "cloudflare_accounts",
    "registrar_accounts",
    "notifications",
    "task_logs",
    "ssl_email_pool",
    "system_config",
    "activity_logs",
)


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("salt", sa.LargeBinary(), nullable=False),
        sa.Column("auth_key_hash", sa.LargeBinary(), nullable=False),
        sa.Column("totp_secret", sa.String(64), nullable=True),
        sa.Column("email_confirmed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("email_confirm_token_hash", sa.LargeBinary(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "sessions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("ip", sa.String(45), nullable=True),
        sa.Column("user_agent", sa.String(255), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_sessions_user_id", "sessions", ["user_id"])
    op.create_index("ix_sessions_token_hash", "sessions", ["token_hash"], unique=True)

    op.create_table(
        "blob_storage",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("blob_kind", sa.String(64), nullable=False),
        sa.Column("version", sa.BigInteger(), nullable=False),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_blob_storage_user_id", "blob_storage", ["user_id"])
    op.create_index("ix_blob_user_version", "blob_storage", ["user_id", "version"])

    op.create_table(
        "audit_log",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("target_type", sa.String(64), nullable=True),
        sa.Column("target_id", sa.String(64), nullable=True),
        sa.Column("device_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("ip", sa.String(45), nullable=True),
        sa.Column("metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "ts",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_audit_log_user_id", "audit_log", ["user_id"])

    op.create_table(
        "recovery_blob",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    op.create_table(
        "sync_state",
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("current_version", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id"),
    )

    for tbl in SCOPED_TABLES:
        op.add_column(tbl, sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True))
        op.create_foreign_key(f"fk_{tbl}_user_id", tbl, "users", ["user_id"], ["id"], ondelete="CASCADE")
        op.create_index(f"ix_{tbl}_user_id", tbl, ["user_id"])

    for tbl in SCOPED_TABLES:
        op.add_column(
            tbl,
            sa.Column("sync_version", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        )
        op.add_column(
            tbl,
            sa.Column("sync_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )

    op.add_column(
        "domains",
        sa.Column(
            "ftp_password_blob_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("blob_storage.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "domains",
        sa.Column(
            "db_password_blob_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("blob_storage.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "servers",
        sa.Column(
            "ssh_password_blob_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("blob_storage.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "servers",
        sa.Column(
            "fastpanel_password_blob_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("blob_storage.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "cloudflare_accounts",
        sa.Column(
            "api_token_blob_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("blob_storage.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "registrar_accounts",
        sa.Column(
            "api_key_blob_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("blob_storage.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "registrar_accounts",
        sa.Column(
            "api_secret_blob_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("blob_storage.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    op.drop_column("domains", "ftp_password_encrypted")
    op.drop_column("domains", "db_password_encrypted")
    op.drop_column("servers", "fastpanel_password_encrypted")
    op.drop_table("server_secrets")
    op.drop_column("cloudflare_accounts", "api_token_encrypted")
    op.drop_column("registrar_accounts", "api_key_encrypted")
    op.drop_column("registrar_accounts", "api_secret_encrypted")


def downgrade() -> None:
    raise NotImplementedError("011 is non-reversible; restore from backup if needed")
