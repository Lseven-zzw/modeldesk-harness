"""Keep the category with each skill draft and published version."""

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None
TABLES = ("modeldesk_enterprise_skill_draft", "modeldesk_enterprise_skill_version")


def upgrade():
    for table in TABLES:
        op.add_column(table, sa.Column("category", sa.String(32), nullable=True))


def downgrade():
    for table in TABLES:
        op.drop_column(table, "category")
