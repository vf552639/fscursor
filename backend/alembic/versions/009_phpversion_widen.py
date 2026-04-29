"""widen domain php_version column

Revision ID: 009_phpversion_widen
Revises: 008_server_metrics
Create Date: 2026-04-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "009_phpversion_widen"
down_revision: Union[str, None] = "008_server_metrics"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "domains",
        "php_version",
        existing_type=sa.String(length=8),
        type_=sa.String(length=16),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "domains",
        "php_version",
        existing_type=sa.String(length=16),
        type_=sa.String(length=8),
        existing_nullable=True,
    )
