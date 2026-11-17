"""Versioned enterprise Skill catalog and audience grants."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

OPTIONS = {"mysql_engine": "InnoDB", "mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}


def upgrade():
    op.create_table(
        "modeldesk_enterprise_skill",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        **OPTIONS,
    )
    op.create_table(
        "modeldesk_enterprise_skill_version",
        sa.Column("code", sa.String(64), sa.ForeignKey("modeldesk_enterprise_skill.code", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True),
        sa.Column("description", sa.String(300), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        **OPTIONS,
    )
    op.create_table(
        "modeldesk_enterprise_skill_grant",
        sa.Column("code", sa.String(64), sa.ForeignKey("modeldesk_enterprise_skill.code", ondelete="CASCADE"),
                  primary_key=True),
        sa.Column("subject_type", sa.String(16), primary_key=True),
        sa.Column("subject_id", mysql.BIGINT(unsigned=True), primary_key=True),
        **OPTIONS,
    )


def downgrade():
    op.drop_table("modeldesk_enterprise_skill_grant")
    op.drop_table("modeldesk_enterprise_skill_version")
    op.drop_table("modeldesk_enterprise_skill")
