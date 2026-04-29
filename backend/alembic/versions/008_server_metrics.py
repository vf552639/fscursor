"""add server metrics columns

Revision ID: 008_server_metrics
Revises: 007_domain_provision_error
Create Date: 2026-04-29
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "008_server_metrics"
down_revision: Union[str, None] = "007_domain_provision_error"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("servers", sa.Column("cpu_usage_pct", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("cpu_count", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("ram_used_mb", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("ram_total_mb", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("disk_used_gb", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("disk_total_gb", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("net_in_kbps", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("net_out_kbps", sa.Integer(), nullable=True))
    op.add_column("servers", sa.Column("os_pretty", sa.String(length=255), nullable=True))
    op.add_column("servers", sa.Column("kernel", sa.String(length=128), nullable=True))
    op.add_column("servers", sa.Column("fastpanel_version", sa.String(length=64), nullable=True))
    op.add_column(
        "servers",
        sa.Column("fastpanel_port", sa.Integer(), nullable=True, server_default=sa.text("8888")),
    )
    op.add_column("servers", sa.Column("metrics_collected_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("servers", "metrics_collected_at")
    op.drop_column("servers", "fastpanel_port")
    op.drop_column("servers", "fastpanel_version")
    op.drop_column("servers", "kernel")
    op.drop_column("servers", "os_pretty")
    op.drop_column("servers", "net_out_kbps")
    op.drop_column("servers", "net_in_kbps")
    op.drop_column("servers", "disk_total_gb")
    op.drop_column("servers", "disk_used_gb")
    op.drop_column("servers", "ram_total_mb")
    op.drop_column("servers", "ram_used_mb")
    op.drop_column("servers", "cpu_count")
    op.drop_column("servers", "cpu_usage_pct")
