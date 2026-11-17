import pytest

from app.common.clock import billing_month, utcnow
from app.common.errors import ModelDeskError
from app.models import CreditRule, MonthlyUsage, User
from app.quota.service import admission, resolve_limit
from app.settings import get_settings


def user(db, department="剪辑部"):
    row = User(
        username="zhang.san",
        password_hash="x",
        display_name="张三",
        department=department,
        role="EMPLOYEE",
        status=1,
        created_at=utcnow(),
    )
    db.add(row)
    db.commit()
    return row


def rule(db, subject_type, subject_id, model_id, limit):
    db.add(
        CreditRule(
            subject_type=subject_type,
            subject_id=subject_id,
            model_id=model_id,
            monthly_token_limit=limit,
            created_at=utcnow(),
        )
    )
    db.commit()


def test_first_match_user_department_default(db):
    u = user(db)
    rule(db, "DEFAULT", "*", 0, 1_000)
    rule(db, "DEPARTMENT", "剪辑部", 0, 2_000)
    rule(db, "USER", str(u.id), 0, 3_000)
    assert resolve_limit(db, u, model_id=7) == 3_000


def test_model_specific_beats_all_models(db):
    u = user(db)
    rule(db, "USER", str(u.id), 0, 3_000)
    rule(db, "USER", str(u.id), 7, 5_000)
    assert resolve_limit(db, u, model_id=7) == 5_000
    assert resolve_limit(db, u, model_id=8) == 3_000


def test_system_default_when_no_rule(db):
    assert resolve_limit(db, user(db), model_id=1) == get_settings().default_monthly_tokens


def test_department_none_skips_department_rules(db):
    u = user(db, department=None)
    rule(db, "DEPARTMENT", "*", 0, 2_000)  # 不应命中
    rule(db, "DEFAULT", "*", 0, 1_000)
    assert resolve_limit(db, u, model_id=1) == 1_000


def test_admission_blocks_at_limit(db):
    u = user(db)
    rule(db, "DEFAULT", "*", 0, 100)
    month = billing_month()
    db.add(MonthlyUsage(user_id=u.id, billing_month=month, used_tokens=100, updated_at=utcnow()))
    db.commit()
    with pytest.raises(ModelDeskError) as blocked:
        admission(db, u, model_id=1, now=utcnow())
    assert blocked.value.status == 429
    assert blocked.value.code == "monthly_token_limit_exceeded"
