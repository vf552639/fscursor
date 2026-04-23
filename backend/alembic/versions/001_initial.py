"""initial schema

Revision ID: 001_initial
Revises:
Create Date: 2026-04-17

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "servers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("ip_address", sa.String(45), nullable=False),
        sa.Column("ssh_port", sa.Integer(), nullable=False, server_default="22"),
        sa.Column("ssh_user", sa.String(64), nullable=False, server_default="root"),
        sa.Column("os", sa.String(64)),
        sa.Column("status", sa.String(32), nullable=False, server_default="new"),
        sa.Column("purchase_date", sa.Date()),
        sa.Column("expiry_date", sa.Date()),
        sa.Column("fastpanel_status", sa.String(32), nullable=False, server_default="not_installed"),
        sa.Column("fastpanel_url", sa.String(512)),
        sa.Column("fastpanel_user", sa.String(128)),
        sa.Column("fastpanel_password_encrypted", sa.Text()),
        sa.Column("notes", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "server_secrets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "server_id",
            sa.Integer(),
            sa.ForeignKey("servers.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("ssh_password_encrypted", sa.Text()),
    )

    op.create_table(
        "registrar_accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(64), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("api_key_encrypted", sa.Text()),
        sa.Column("api_secret_encrypted", sa.Text()),
        sa.Column("api_user", sa.String(128)),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "cloudflare_accounts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("account_id", sa.String(128)),
        sa.Column("api_token_encrypted", sa.Text()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "domains",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("domain_name", sa.String(255), nullable=False, unique=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="new"),
        sa.Column(
            "registrar_id",
            sa.Integer(),
            sa.ForeignKey("registrar_accounts.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "server_id",
            sa.Integer(),
            sa.ForeignKey("servers.id", ondelete="SET NULL"),
        ),
        sa.Column(
            "cloudflare_account_id",
            sa.Integer(),
            sa.ForeignKey("cloudflare_accounts.id", ondelete="SET NULL"),
        ),
        sa.Column("cloudflare_zone_id", sa.String(128)),
        sa.Column("cloudflare_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("expiry_date", sa.Date()),
        sa.Column("ns_status", sa.String(32)),
        sa.Column("ns_updated_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "task_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("entity_type", sa.String(64), nullable=False),
        sa.Column("entity_id", sa.Integer()),
        sa.Column("task_type", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("log_text", sa.Text()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_table(
        "activity_logs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("entity_type", sa.String(64), nullable=False),
        sa.Column("entity_id", sa.Integer()),
        sa.Column("entity_name", sa.String(255)),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text())),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_index("ix_domains_status", "domains", ["status"])
    op.create_index("ix_servers_status", "servers", ["status"])
    op.create_index("ix_task_logs_entity", "task_logs", ["entity_type", "entity_id"])
    op.create_index("ix_activity_logs_entity", "activity_logs", ["entity_type", "entity_id"])


def downgrade() -> None:
    op.drop_index("ix_activity_logs_entity", table_name="activity_logs")
    op.drop_index("ix_task_logs_entity", table_name="task_logs")
    op.drop_index("ix_servers_status", table_name="servers")
    op.drop_index("ix_domains_status", table_name="domains")
    op.drop_table("activity_logs")
    op.drop_table("task_logs")
    op.drop_table("domains")
    op.drop_table("cloudflare_accounts")
    op.drop_table("registrar_accounts")
    op.drop_table("server_secrets")
    op.drop_table("servers")
