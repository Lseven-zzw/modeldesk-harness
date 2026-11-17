"""Add the department hierarchy with existing departments as roots."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import mysql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("modeldesk_department", sa.Column("parent_id", mysql.BIGINT(unsigned=True)))
    op.create_index("ix_modeldesk_department_parent_id", "modeldesk_department", ["parent_id"])
    op.create_foreign_key(
        "fk_department_parent", "modeldesk_department", "modeldesk_department", ["parent_id"], ["id"]
    )


def downgrade():
    op.drop_constraint("fk_department_parent", "modeldesk_department", type_="foreignkey")
    op.drop_index("ix_modeldesk_department_parent_id", table_name="modeldesk_department")
    op.drop_column("modeldesk_department", "parent_id")
