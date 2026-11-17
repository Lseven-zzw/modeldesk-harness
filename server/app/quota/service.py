from datetime import datetime

from sqlalchemy import select, tuple_
from sqlalchemy.orm import Session

from app.common.clock import billing_month
from app.common.errors import ModelDeskError
from app.models import CreditRule, MonthlyUsage, User
from app.settings import get_settings


def _subject_pairs(user: User) -> list[tuple[str, str]]:
    pairs = [("USER", str(user.id))]
    if user.department:
        pairs.append(("DEPARTMENT", user.department))
    pairs.append(("DEFAULT", "*"))
    return pairs


def resolve_limit(db: Session, user: User, model_id: int) -> int:
    return resolve_limits(db, [user], model_id)[user.id]


def resolve_limits(db: Session, users: list[User], model_id: int) -> dict[int, int]:
    models = (model_id, 0) if model_id else (0,)
    candidates = {user.id: _subject_pairs(user) for user in users}
    subjects = {pair for pairs in candidates.values() for pair in pairs}
    if not subjects:
        return {}
    rules = {
        (rule.subject_type, rule.subject_id, rule.model_id): rule.monthly_token_limit
        for rule in db.scalars(select(CreditRule).where(
            tuple_(CreditRule.subject_type, CreditRule.subject_id).in_(sorted(subjects)),
            CreditRule.model_id.in_(models),
        ))
    }
    default = get_settings().default_monthly_tokens
    return {
        user_id: next(
            (rules[*pair, model] for pair in pairs for model in models if (*pair, model) in rules),
            default,
        )
        for user_id, pairs in candidates.items()
    }


def used_tokens(db: Session, user_id: int, month: str) -> int:
    row = db.get(MonthlyUsage, {"user_id": user_id, "billing_month": month})
    return int(row.used_tokens) if row is not None else 0


def admission(db: Session, user: User, model_id: int, now: datetime) -> tuple[int, int, str]:
    month = billing_month(now)
    limit = resolve_limit(db, user, model_id)
    used = used_tokens(db, user.id, month)
    if used >= limit:
        raise ModelDeskError(
            429, "monthly_token_limit_exceeded", "本月企业模型额度已用完，请联系管理员"
        )
    return limit, used, month
