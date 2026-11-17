import pytest
from sqlalchemy.exc import IntegrityError

from app.common.clock import utcnow
from app.models import CreditRule, ModelGrant, User


def test_user_username_is_unique(db):
    db.add(
        User(
            username="zhang.san",
            password_hash="x",
            display_name="张三",
            department="剪辑部",
            role="EMPLOYEE",
            status=1,
            created_at=utcnow(),
        )
    )
    db.commit()
    db.add(
        User(
            username="zhang.san",
            password_hash="y",
            display_name="李四",
            department=None,
            role="EMPLOYEE",
            status=1,
            created_at=utcnow(),
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()


def test_grant_and_rule_sentinels_avoid_null_uniqueness(db):
    db.add(ModelGrant(model_id=1, subject_type="EVERYONE", subject_id="*", created_at=utcnow()))
    db.add(
        CreditRule(
            subject_type="DEFAULT",
            subject_id="*",
            model_id=0,
            monthly_token_limit=10_000_000,
            created_at=utcnow(),
        )
    )
    db.commit()
    db.add(ModelGrant(model_id=1, subject_type="EVERYONE", subject_id="*", created_at=utcnow()))
    with pytest.raises(IntegrityError):
        db.commit()
