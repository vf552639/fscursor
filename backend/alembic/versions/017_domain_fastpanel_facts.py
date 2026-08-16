"""domain fastpanel facts: read-back snapshot of a domain's state on the server

Revision ID: 017_domain_fastpanel_facts
Revises: 016_server_consecutive_failures
Create Date: 2026-08-16

The desktop reads a domain's live state from its server over SSH and writes the
result here (``POST /domains/{id}/facts``), so the read-only web can show it and
it survives a restart. This migration is the place those facts land.

Two timestamps, not one, and that is the whole point of the split. ``fp_checked_at``
is "when we last TRIED to read" and moves on every attempt, success or failure.
``fp_facts_at`` is "when we last SUCCEEDED" and moves only on success. A failed
attempt must not wipe the last good snapshot (``fp_facts``) nor rejuvenate it
(``fp_facts_at``) — see principle #6 in CLAUDE.md, "do not paint ignorance as
health". Collapsing the two would make a week-old snapshot look fresh the moment
a single SSH hiccup bumped a shared "last checked" column.

All columns are nullable with no server default: "never read" is the honest
starting state for every existing row, and there is no truthful value to backfill.
``fp_facts`` mirrors ``domains.nginx_presets`` — ``sa.JSON()``, the type this
project already uses for opaque JSON snapshots.
"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "017_domain_fastpanel_facts"
down_revision: Optional[str] = "016_server_consecutive_failures"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.add_column("domains", sa.Column("fp_checked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("domains", sa.Column("fp_check_error", sa.Text(), nullable=True))
    op.add_column("domains", sa.Column("fp_facts", sa.JSON(), nullable=True))
    op.add_column("domains", sa.Column("fp_facts_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("domains", sa.Column("php_handler", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("domains", "php_handler")
    op.drop_column("domains", "fp_facts_at")
    op.drop_column("domains", "fp_facts")
    op.drop_column("domains", "fp_check_error")
    op.drop_column("domains", "fp_checked_at")
