"""Extend model delegation to departments and groups and version each model's grants."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("modeldesk_model", sa.Column(
        "delegation_revision", mysql.BIGINT(unsigned=True), nullable=False, server_default=sa.text("0"),
    ))
    op.create_table(
        "modeldesk_model_admin_subject_grant",
        sa.Column("model_id", mysql.BIGINT(unsigned=True),
                  sa.ForeignKey("modeldesk_model.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("subject_type", sa.String(16), primary_key=True),
        sa.Column("subject_id", mysql.BIGINT(unsigned=True), primary_key=True),
        sa.Column("permission", sa.String(48), primary_key=True),
        sa.Column("include_descendants", sa.Boolean(), nullable=False, server_default=sa.text("0")),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )
    op.create_index("ix_model_admin_subject", "modeldesk_model_admin_subject_grant", ["subject_type", "subject_id"])
    op.execute(sa.text("""
        INSERT INTO modeldesk_model_admin_subject_grant (model_id, subject_type, subject_id, permission)
        SELECT model_id, 'USER', user_id, permission FROM modeldesk_model_admin_grant
    """))
    op.drop_table("modeldesk_model_admin_grant")


def downgrade():
    connection = op.get_bind()
    if not op.get_context().as_sql and connection.scalar(sa.text("""
        SELECT 1 FROM modeldesk_model_admin_subject_grant WHERE subject_type <> 'USER' LIMIT 1
    """)):
        raise RuntimeError("Revoke department and group model delegations before downgrading 0009")
    if op.get_context().as_sql:
        raise RuntimeError("Downgrade 0009 requires a live database to check delegation types")
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
    op.execute(sa.text("""
        INSERT INTO modeldesk_model_admin_grant (model_id, user_id, permission)
        SELECT model_id, subject_id, permission FROM modeldesk_model_admin_subject_grant
    """))
    op.drop_table("modeldesk_model_admin_subject_grant")
    op.drop_column("modeldesk_model", "delegation_revision")
