"""Delegate administrative operations for individual models."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "modeldesk_model_admin_grant",
        sa.Column("model_id", mysql.BIGINT(unsigned=True),
                  sa.ForeignKey("modeldesk_model.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", mysql.BIGINT(unsigned=True),
                  sa.ForeignKey("modeldesk_user.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("permission", sa.String(48), primary_key=True),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index("ix_modeldesk_model_admin_grant_user_id", "modeldesk_model_admin_grant", ["user_id"])


def downgrade():
    op.drop_table("modeldesk_model_admin_grant")
