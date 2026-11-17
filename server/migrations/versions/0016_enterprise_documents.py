"""Create the enterprise document library and access grants."""

import sqlalchemy as sa
from alembic import op

from app.models import AutoID, UnsignedID

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "modeldesk_enterprise_document",
        sa.Column("id", AutoID, primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("updated_by", UnsignedID, nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    op.create_table(
        "modeldesk_enterprise_document_grant",
        sa.Column("document_id", UnsignedID, sa.ForeignKey("modeldesk_enterprise_document.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("subject_type", sa.String(16), primary_key=True),
        sa.Column("subject_id", UnsignedID, primary_key=True),
        mysql_engine="InnoDB",
    )


def downgrade():
    op.drop_table("modeldesk_enterprise_document_grant")
    op.drop_table("modeldesk_enterprise_document")
