"""zk cleanup: drop legacy ssl_email_pool

Revision ID: 013_drop_ssl_email_pool
Revises: 012_drop_server_notes
Create Date: 2026-08-03

"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "013_drop_ssl_email_pool"
down_revision: Optional[str] = "012_drop_server_notes"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.drop_table("ssl_email_pool")


def downgrade() -> None:
    # Mirrors the table as it existed after 006_provisioning_and_ssl_pool
    # (base columns) plus 011_zero_knowledge_v1 (user_id / sync_* scoping).
    op.create_table(
        "ssl_email_pool",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False, unique=True),
        sa.Column("usage_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("usage_cap", sa.Integer(), nullable=False, server_default=sa.text("100")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("sync_version", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
        sa.Column(
            "sync_deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_ssl_email_pool_user_id", ondelete="CASCADE"
        ),
    )
    op.create_index("ix_ssl_email_pool_user_id", "ssl_email_pool", ["user_id"])
