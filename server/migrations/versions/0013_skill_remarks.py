"""Keep management remarks with Skill drafts and published versions."""

import sqlalchemy as sa
from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None
TABLES = ("modeldesk_enterprise_skill_draft", "modeldesk_enterprise_skill_version")


def upgrade():
    for table in TABLES:
        op.add_column(table, sa.Column("remarks", sa.Text(), nullable=True))


def downgrade():
    for table in TABLES:
        op.drop_column(table, "remarks")
