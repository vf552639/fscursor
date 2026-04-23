"""domain purchase date and notifications

Revision ID: 002_domain_purchase_and_notifications
Revises: 001_initial
Create Date: 2026-04-23
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "002_domain_purchase_and_notifications"
down_revision: Union[str, None] = "001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("domains", sa.Column("purchase_date", sa.Date(), nullable=True))

    op.create_table(
        "notifications",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("type", sa.String(length=64), nullable=False),
        sa.Column("entity_type", sa.String(length=64), nullable=False),
        sa.Column("entity_id", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("dedup_key", sa.String(length=255), nullable=False, unique=True),
        sa.Column("is_read", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    op.create_index("ix_notifications_is_read", "notifications", ["is_read"])
    op.create_index(
        "ix_notifications_entity",
        "notifications",
        ["entity_type", "entity_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_entity", table_name="notifications")
    op.drop_index("ix_notifications_is_read", table_name="notifications")
    op.drop_table("notifications")
    op.drop_column("domains", "purchase_date")
