"""add domain last_provision_error field

Revision ID: 007_domain_provision_error
Revises: 006_provisioning_and_ssl_pool
Create Date: 2026-04-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "007_domain_provision_error"
down_revision: Union[str, None] = "006_provisioning_and_ssl_pool"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("domains", sa.Column("last_provision_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("domains", "last_provision_error")
