"""add server uptime check fields

Revision ID: 005_server_uptime
Revises: 004_indexes
Create Date: 2026-04-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005_server_uptime"
down_revision: Union[str, None] = "004_indexes"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("servers", sa.Column("uptime_seconds", sa.BigInteger(), nullable=True))
    op.add_column("servers", sa.Column("last_check_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("servers", sa.Column("last_check_ok", sa.Boolean(), nullable=True))
    op.add_column("servers", sa.Column("last_check_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("servers", "last_check_error")
    op.drop_column("servers", "last_check_ok")
    op.drop_column("servers", "last_check_at")
    op.drop_column("servers", "uptime_seconds")
