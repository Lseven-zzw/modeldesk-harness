"""Register stable department codes and preserve existing department references."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "modeldesk_department",
        sa.Column("id", mysql.BIGINT(unsigned=True), primary_key=True, autoincrement=True),
        sa.Column("code", sa.String(100), nullable=False, unique=True),
        sa.Column("name", sa.String(100), nullable=False),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_bin",
    )
    op.execute(sa.text("""
        INSERT INTO modeldesk_department (code, name)
        SELECT code, code FROM (
            SELECT department COLLATE utf8mb4_bin AS code FROM modeldesk_user
            UNION SELECT department COLLATE utf8mb4_bin FROM modeldesk_admin_user_role
            UNION SELECT subject_id COLLATE utf8mb4_bin FROM modeldesk_model_grant
                WHERE subject_type = 'DEPARTMENT'
            UNION SELECT subject_id COLLATE utf8mb4_bin FROM modeldesk_credit_rule
                WHERE subject_type = 'DEPARTMENT'
        ) AS existing_departments WHERE code IS NOT NULL AND code <> ''
    """))


def downgrade():
    op.drop_table("modeldesk_department")
