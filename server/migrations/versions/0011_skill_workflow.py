"""Store editable drafts separately from immutable published Skill versions."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("modeldesk_enterprise_skill_version", sa.Column("published_by", mysql.BIGINT(unsigned=True)))
    op.create_table(
        "modeldesk_enterprise_skill_draft",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("revision", sa.String(32), nullable=False),
        sa.Column("description", sa.String(300), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("grants", sa.JSON(), nullable=False),
        sa.Column("updated_by", mysql.BIGINT(unsigned=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
        mysql_collate="utf8mb4_unicode_ci",
    )


def downgrade():
    if op.get_context().as_sql or op.get_bind().scalar(sa.text(
        "SELECT 1 FROM modeldesk_enterprise_skill_draft LIMIT 1"
    )):
        raise RuntimeError("Check and remove unpublished skill drafts before downgrading 0011")
    op.drop_table("modeldesk_enterprise_skill_draft")
    op.drop_column("modeldesk_enterprise_skill_version", "published_by")
