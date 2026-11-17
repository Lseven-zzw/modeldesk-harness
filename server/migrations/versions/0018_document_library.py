from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

from app.models import UnsignedID

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("modeldesk_enterprise_document") as table:
        table.add_column(sa.Column("owner_id", UnsignedID, nullable=True))
        table.create_index("ix_modeldesk_document_owner", ["owner_id"])
    op.create_table(
        "modeldesk_document_file",
        sa.Column("document_id", UnsignedID, sa.ForeignKey(
            "modeldesk_enterprise_document.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("filename", sa.String(240), nullable=False),
        sa.Column("media_type", sa.String(120), nullable=False),
        sa.Column("parse_status", sa.String(16), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("data", sa.LargeBinary().with_variant(mysql.LONGBLOB(), "mysql"), nullable=False),
        mysql_charset="utf8mb4",
    )


def downgrade():
    op.drop_table("modeldesk_document_file")
    with op.batch_alter_table("modeldesk_enterprise_document") as table:
        table.drop_index("ix_modeldesk_document_owner")
        table.drop_column("owner_id")
