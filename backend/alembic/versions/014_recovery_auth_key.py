"""recovery proof-of-phrase: bcrypt hash of the recovery auth key

Revision ID: 014_recovery_auth_key
Revises: 013_drop_ssl_email_pool
Create Date: 2026-08-03

The column lives on ``recovery_blob`` (not ``users``) so that the recovery
credential and the blob it authorises are created, updated and deleted as a
single row. Nullable on purpose: rows created before this migration have no
hash, and ``/auth/recovery/finish`` refuses to run for them (the owner must
reconfigure recovery while signed in).
"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "014_recovery_auth_key"
down_revision: Optional[str] = "013_drop_ssl_email_pool"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.add_column(
        "recovery_blob",
        sa.Column("recovery_auth_key_hash", sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("recovery_blob", "recovery_auth_key_hash")
