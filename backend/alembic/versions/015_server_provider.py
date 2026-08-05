"""server hosting provider: free-text name of where the box was bought

Revision ID: 015_server_provider
Revises: 014_recovery_auth_key
Create Date: 2026-08-05

Free text on purpose, not an enum or a lookup table: the owner runs boxes at
dozens of hosters and a new one must not require a code change or a migration.
The UI feeds a ``datalist`` from the values already stored, which is all the
"list of providers" this product needs.

Nullable and without a default: every existing row predates the column and
"provider unknown" is a real state, not a placeholder to be backfilled.

``String(64)`` is the same number as ``PROVIDER_MAX_LEN`` in
``app/core/validators.py`` — the schema refuses a longer value with 422 so that
Postgres never has to answer ``StringDataRightTruncation`` (a 500) instead.
"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "015_server_provider"
down_revision: Optional[str] = "014_recovery_auth_key"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.add_column("servers", sa.Column("provider", sa.String(64), nullable=True))


def downgrade() -> None:
    op.drop_column("servers", "provider")
