"""zk cleanup: drop plaintext servers.notes

Revision ID: 012_drop_server_notes
Revises: 011_zero_knowledge_v1
Create Date: 2026-08-03

"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "012_drop_server_notes"
down_revision: Optional[str] = "011_zero_knowledge_v1"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.drop_column("servers", "notes")


def downgrade() -> None:
    op.add_column("servers", sa.Column("notes", sa.Text(), nullable=True))
