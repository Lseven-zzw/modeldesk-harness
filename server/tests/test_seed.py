from base64 import urlsafe_b64encode

from sqlalchemy import func, select

from app.common.crypto import SecretBox
from app.models import CreditRule, ModelGrant, ModelRow, User
from app.seed import UpstreamSeed, seed
from app.settings import Settings


def test_seed_is_idempotent(db):
    settings = Settings(
        default_monthly_tokens=10_000_000, master_key=urlsafe_b64encode(bytes(32)).decode()
    )
    upstream = UpstreamSeed(
        code="deepseek-chat",
        display_name="DeepSeek Chat",
        upstream_model="deepseek-chat",
        upstream_base="https://api.deepseek.com/v1",
        api_key="sk-test-1234",
    )
    for _ in range(2):
        seed(
            db,
            settings,
            admin_password="admin-pass-123",
            employee_password="employee-pass-1",
            upstream=upstream,
        )

    assert db.scalar(select(func.count()).select_from(User)) == 3
    model = db.scalar(select(ModelRow).where(ModelRow.code == "deepseek-chat"))
    assert SecretBox(settings.master_key).decrypt(model.api_key_cipher) == "sk-test-1234"
    assert model.extra_config["key_hint"] == "1234"
    assert db.scalar(select(func.count()).select_from(ModelGrant)) == 1
    rule = db.scalar(select(CreditRule))
    assert (rule.subject_type, rule.subject_id, rule.model_id) == ("DEFAULT", "*", 0)
    assert rule.monthly_token_limit == 10_000_000


def test_reseeding_preserves_removed_grants(db):
    from sqlalchemy import delete

    settings = Settings()
    upstream = UpstreamSeed(
        code="deepseek-chat",
        display_name="DeepSeek Chat",
        upstream_model="deepseek-chat",
        upstream_base="https://api.deepseek.com/v1",
        api_key="sk-test-1234",
    )
    passwords = {"admin_password": "admin-pass-123", "employee_password": "employee-pass-1"}
    seed(db, settings, upstream=upstream, **passwords)
    db.execute(delete(ModelGrant))
    db.commit()
    seed(db, settings, upstream=upstream, **passwords)
    assert db.scalar(select(func.count()).select_from(ModelGrant)) == 0
