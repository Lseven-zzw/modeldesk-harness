"""Add reversible department archival and opt-in descendant scopes."""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("modeldesk_department", sa.Column(
        "archived", sa.Boolean(), nullable=False, server_default=sa.text("0"),
    ))
    for table in ("modeldesk_admin_user_role", "modeldesk_user_group_role"):
        op.add_column(table, sa.Column(
            "include_descendants", sa.Boolean(), nullable=False, server_default=sa.text("0"),
        ))


def downgrade():
    for table in ("modeldesk_admin_user_role", "modeldesk_user_group_role"):
        op.drop_column(table, "include_descendants")
    op.drop_column("modeldesk_department", "archived")
