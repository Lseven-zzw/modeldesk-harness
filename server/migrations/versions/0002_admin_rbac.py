"""Add configurable administrative roles, permissions and scoped user assignments."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

OPTIONS = {
    "mysql_engine": "InnoDB",
    "mysql_charset": "utf8mb4",
    "mysql_collate": "utf8mb4_unicode_ci",
}


def upgrade():
    op.create_table(
        "modeldesk_admin_role",
        sa.Column("code", sa.String(48), primary_key=True),
        sa.Column("name", sa.String(100), nullable=False),
        **OPTIONS,
    )
    op.create_table(
        "modeldesk_admin_role_permission",
        sa.Column(
            "role_code",
            sa.String(48),
            sa.ForeignKey("modeldesk_admin_role.code", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("permission", sa.String(48), primary_key=True),
        **OPTIONS,
    )
    op.create_table(
        "modeldesk_admin_user_role",
        sa.Column(
            "user_id",
            sa.BigInteger().with_variant(mysql.BIGINT(unsigned=True), "mysql"),
            sa.ForeignKey("modeldesk_user.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "role_code",
            sa.String(48),
            sa.ForeignKey("modeldesk_admin_role.code", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "department",
            sa.String(100).with_variant(mysql.VARCHAR(100, collation="utf8mb4_bin"), "mysql"),
            primary_key=True,
        ),
        **OPTIONS,
    )
    op.create_index("idx_admin_user_role_code", "modeldesk_admin_user_role", ["role_code"])


def downgrade():
    op.drop_table("modeldesk_admin_user_role")
    op.drop_table("modeldesk_admin_role_permission")
    op.drop_table("modeldesk_admin_role")
