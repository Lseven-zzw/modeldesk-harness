"""Persist imported Skill frontmatter and attachments per draft and version."""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None
TABLES = ("modeldesk_enterprise_skill_draft", "modeldesk_enterprise_skill_version")


def upgrade():
    for table in TABLES:
        op.alter_column(table, "description", existing_type=sa.String(300),
                        type_=sa.String(1024), existing_nullable=False)
        op.add_column(table, sa.Column("bundle", sa.JSON(), nullable=True))
        op.add_column(table, sa.Column("asset_data", sa.JSON(), nullable=True))


def downgrade():
    if op.get_context().as_sql:
        raise RuntimeError("Downgrade 0012 requires a live database to check imported Skill content")
    for table in TABLES:
        if op.get_bind().scalar(sa.text(
            f"SELECT 1 FROM {table} WHERE bundle IS NOT NULL AND JSON_TYPE(bundle) <> 'NULL' LIMIT 1"
        )):
            raise RuntimeError("Remove imported Skill bundles before downgrading 0012")
        if op.get_bind().scalar(sa.text(f"SELECT 1 FROM {table} WHERE CHAR_LENGTH(description) > 300 LIMIT 1")):
            raise RuntimeError("Shorten Skill descriptions to 300 characters before downgrading 0012")
    for table in TABLES:
        op.drop_column(table, "asset_data")
        op.drop_column(table, "bundle")
        op.alter_column(table, "description", existing_type=sa.String(1024),
                        type_=sa.String(300), existing_nullable=False)
