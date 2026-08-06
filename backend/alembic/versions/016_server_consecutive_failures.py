"""server monitoring: counter of consecutive failed TCP checks

Revision ID: 016_server_consecutive_failures
Revises: 015_server_provider
Create Date: 2026-08-06

The monitor confirms an outage only after two failed checks in a row (a single
miss is network hiccup, not a dead box), so the threshold needs somewhere to
live between two runs six hours apart. That is all this column is.

``NOT NULL DEFAULT 0``, unlike the nullable ``provider`` next door: "no misses
yet" is a real, knowable state for every existing row, so the backfill is
honest rather than a placeholder. The server default also keeps rows inserted
by anything that does not know about the column at zero instead of NULL, which
would make ``failures + 1`` evaluate to NULL and quietly disable the threshold.
"""
from typing import Optional, Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "016_server_consecutive_failures"
down_revision: Optional[str] = "015_server_provider"
branch_labels: Optional[Union[str, Sequence[str]]] = None
depends_on: Optional[Union[str, Sequence[str]]] = None


def upgrade() -> None:
    op.add_column(
        "servers",
        sa.Column(
            "consecutive_failures",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    op.drop_column("servers", "consecutive_failures")
