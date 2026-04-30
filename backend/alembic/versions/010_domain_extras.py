"""add domain extras

Revision ID: 010_domain_extras
Revises: 009_phpversion_widen
Create Date: 2026-04-30
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "010_domain_extras"
down_revision: str | None = "009_phpversion_widen"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("domains", sa.Column("db_name", sa.String(length=64), nullable=True))
    op.add_column("domains", sa.Column("db_user", sa.String(length=64), nullable=True))
    op.add_column("domains", sa.Column("db_password_encrypted", sa.Text(), nullable=True))
    op.add_column("domains", sa.Column("ssl_expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("domains", sa.Column("ssl_issuer", sa.String(length=64), nullable=True))
    op.add_column(
        "domains",
        sa.Column("ns_check_mode", sa.String(length=16), nullable=True, server_default="auto"),
    )
    op.add_column("domains", sa.Column("nginx_override", sa.Text(), nullable=True))
    op.add_column("domains", sa.Column("nginx_presets", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("domains", "nginx_presets")
    op.drop_column("domains", "nginx_override")
    op.drop_column("domains", "ns_check_mode")
    op.drop_column("domains", "ssl_issuer")
    op.drop_column("domains", "ssl_expires_at")
    op.drop_column("domains", "db_password_encrypted")
    op.drop_column("domains", "db_user")
    op.drop_column("domains", "db_name")
