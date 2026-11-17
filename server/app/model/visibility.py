import re

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.common.errors import ModelDeskError
from app.models import ModelGrant, ModelRow, User

_MODEL_REF = re.compile(r"modeldesk:([0-9]{1,20})")
_MAX_MODEL_ID = 2**64 - 1


def parse_model_ref(ref: str) -> int:
    match = _MODEL_REF.fullmatch(ref)
    model_id = int(match[1]) if match else 0
    if not 0 < model_id <= _MAX_MODEL_ID:
        raise ModelDeskError(400, "invalid_request", "model 必须是 modeldesk:<id>")
    return model_id


def model_grant_filter(user: User):
    conditions = [
        and_(ModelGrant.subject_type == "EVERYONE", ModelGrant.subject_id == "*"),
        and_(ModelGrant.subject_type == "USER", ModelGrant.subject_id == str(user.id)),
    ]
    if user.department:
        conditions.append(
            and_(ModelGrant.subject_type == "DEPARTMENT", ModelGrant.subject_id == user.department)
        )
    return or_(*conditions)


def _visible_query(user: User):
    query = select(ModelRow).where(ModelRow.enabled == 1)
    if user.role == "ADMIN":
        return query
    return query.where(ModelRow.id.in_(select(ModelGrant.model_id).where(model_grant_filter(user))))


def visible_models(db: Session, user: User) -> list[ModelRow]:
    return list(db.scalars(_visible_query(user).order_by(ModelRow.id)))


def require_model_visible(db: Session, user: User, model_id: int) -> ModelRow:
    if db.get_bind().dialect.name != "sqlite" or model_id <= 2**63 - 1:
        row = db.scalar(_visible_query(user).where(ModelRow.id == model_id))
        if row is not None:
            return row
    raise ModelDeskError(403, "model_not_allowed", "该模型未对你的账号开放")
