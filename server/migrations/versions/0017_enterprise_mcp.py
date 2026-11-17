"""Store enterprise MCP servers, encrypted credentials and tool policies."""

import sqlalchemy as sa
from alembic import op

from app.models import AutoID, CipherBytes

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "modeldesk_enterprise_mcp_server",
        sa.Column("id", AutoID, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("endpoint", sa.String(512), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("guide", sa.Text(), nullable=False),
        sa.Column("token_cipher", CipherBytes, nullable=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("grants", sa.JSON(), nullable=False),
        sa.Column("tools", sa.JSON(), nullable=False),
        sa.Column("discovered_at", sa.DateTime(), nullable=True),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )


def downgrade():
    op.drop_table("modeldesk_enterprise_mcp_server")
