"""Store reusable upstream channel credentials."""

import sqlalchemy as sa
from alembic import op

from app.models import AutoID, CipherBytes, UnsignedID

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "modeldesk_model_channel",
        sa.Column("id", AutoID, primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("upstream_kind", sa.String(32), nullable=False),
        sa.Column("upstream_base", sa.String(255), nullable=False),
        sa.Column("api_key_cipher", CipherBytes, nullable=False),
        sa.Column("key_hint", sa.String(4), nullable=False),
        mysql_engine="InnoDB",
        mysql_charset="utf8mb4",
    )
    if op.get_context().dialect.name == "sqlite":
        op.execute(
            "ALTER TABLE modeldesk_model ADD COLUMN channel_id BIGINT "
            "CONSTRAINT fk_model_channel REFERENCES modeldesk_model_channel (id)"
        )
    else:
        op.add_column("modeldesk_model", sa.Column("channel_id", UnsignedID, nullable=True))
        op.create_foreign_key("fk_model_channel", "modeldesk_model", "modeldesk_model_channel", ["channel_id"], ["id"])
    op.create_index("ix_modeldesk_model_channel_id", "modeldesk_model", ["channel_id"])


def downgrade():
    if op.get_bind().scalar(sa.text("SELECT COUNT(*) FROM modeldesk_model_channel")):
        raise RuntimeError("Remove channel configuration before downgrading")
    with op.batch_alter_table("modeldesk_model") as batch:
        batch.drop_index("ix_modeldesk_model_channel_id")
        batch.drop_constraint("fk_model_channel", type_="foreignkey")
        batch.drop_column("channel_id")
    op.drop_table("modeldesk_model_channel")
