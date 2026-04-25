"""add domains and notifications indexes

Revision ID: 004_indexes
Revises: 003_system_config
Create Date: 2026-04-25
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "004_indexes"
down_revision: Union[str, None] = "003_system_config"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("ix_domains_server_id", "domains", ["server_id"])
    op.create_index("ix_domains_registrar_id", "domains", ["registrar_id"])
    op.create_index("ix_domains_cloudflare_account_id", "domains", ["cloudflare_account_id"])
    op.create_index(
        "ix_notifications_unread_created",
        "notifications",
        ["is_read", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_notifications_unread_created", table_name="notifications")
    op.drop_index("ix_domains_cloudflare_account_id", table_name="domains")
    op.drop_index("ix_domains_registrar_id", table_name="domains")
    op.drop_index("ix_domains_server_id", table_name="domains")
