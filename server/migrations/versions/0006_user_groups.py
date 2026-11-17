"""Add reusable user groups and scoped role assignments."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

OPTIONS = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}


def upgrade():
    op.create_table(
        "modeldesk_user_group",
        sa.Column("id", mysql.BIGINT(unsigned=True), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(100), nullable=False, unique=True),
        **OPTIONS,
    )
    op.create_table(
        "modeldesk_user_group_member",
        sa.Column("group_id", mysql.BIGINT(unsigned=True),
                  sa.ForeignKey("modeldesk_user_group.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", mysql.BIGINT(unsigned=True),
                  sa.ForeignKey("modeldesk_user.id", ondelete="CASCADE"), primary_key=True),
        **OPTIONS,
    )
    op.create_index("ix_modeldesk_user_group_member_user_id", "modeldesk_user_group_member", ["user_id"])
    op.create_table(
        "modeldesk_user_group_role",
        sa.Column("group_id", mysql.BIGINT(unsigned=True),
                  sa.ForeignKey("modeldesk_user_group.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role_code", sa.String(48),
                  sa.ForeignKey("modeldesk_admin_role.code", ondelete="CASCADE"), primary_key=True),
        sa.Column("department", mysql.VARCHAR(100, collation="utf8mb4_bin"), primary_key=True),
        **OPTIONS,
    )
    op.create_index("ix_modeldesk_user_group_role_role_code", "modeldesk_user_group_role", ["role_code"])


def downgrade():
    op.drop_table("modeldesk_user_group_role")
    op.drop_table("modeldesk_user_group_member")
    op.drop_table("modeldesk_user_group")
