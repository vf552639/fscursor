"""add domain provisioning fields and ssl email pool

Revision ID: 006_provisioning_and_ssl_pool
Revises: 005_server_uptime
Create Date: 2026-04-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "006_provisioning_and_ssl_pool"
down_revision: Union[str, None] = "005_server_uptime"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("domains", sa.Column("site_user", sa.String(length=64), nullable=True))
    op.add_column("domains", sa.Column("site_path", sa.String(length=255), nullable=True))
    op.add_column("domains", sa.Column("ftp_user", sa.String(length=64), nullable=True))
    op.add_column("domains", sa.Column("ftp_password_encrypted", sa.Text(), nullable=True))
    op.add_column(
        "domains",
        sa.Column(
            "ssl_status",
            sa.String(length=16),
            nullable=True,
            server_default="none",
        ),
    )
    op.add_column(
        "domains", sa.Column("ssl_email_used", sa.String(length=255), nullable=True)
    )
    op.add_column("domains", sa.Column("php_version", sa.String(length=8), nullable=True))

    op.create_table(
        "ssl_email_pool",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False, unique=True),
        sa.Column(
            "usage_count",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "usage_cap",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("100"),
        ),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )

    op.execute(
        sa.text(
            """
            INSERT INTO ssl_email_pool (email, usage_count, usage_cap, is_active)
            VALUES (:email, 0, 100, true)
            ON CONFLICT (email) DO NOTHING
            """
        ).bindparams(email="madesto.karl@gmail.com")
    )


def downgrade() -> None:
    op.drop_table("ssl_email_pool")
    op.drop_column("domains", "php_version")
    op.drop_column("domains", "ssl_email_used")
    op.drop_column("domains", "ssl_status")
    op.drop_column("domains", "ftp_password_encrypted")
    op.drop_column("domains", "ftp_user")
    op.drop_column("domains", "site_path")
    op.drop_column("domains", "site_user")
