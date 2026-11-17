from typing import Literal

from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.common.errors import ModelDeskError
from app.models import Department, User, UserGroup, UserGroupMember


class ResourceAudience(BaseModel):
    subject_type: Literal["EVERYONE", "USER", "DEPARTMENT", "GROUP"]
    subject_id: int = Field(ge=0, le=2**63 - 1)


def validate_audience(db: Session, audience: list[ResourceAudience]) -> set[tuple[str, int]]:
    grants = {(item.subject_type, item.subject_id) for item in audience}
    if len(grants) != len(audience) or any(
        (kind == "EVERYONE") != (subject_id == 0) for kind, subject_id in grants
    ):
        raise ModelDeskError(400, "invalid_request", "授权范围重复或无效")
    for kind, model in (("USER", User), ("DEPARTMENT", Department), ("GROUP", UserGroup)):
        ids = {subject_id for subject, subject_id in grants if kind == subject}
        if not ids:
            continue
        query = select(model.id).where(model.id.in_(ids))
        if kind == "DEPARTMENT":
            query = query.where(Department.archived.is_(False))
        if set(db.scalars(query.with_for_update())) != ids:
            raise ModelDeskError(400, "invalid_request", "授权对象不存在或已归档")
    return grants


def audience_options(db: Session) -> dict:
    return {
        "USER": [{"id": row.id, "name": f"{row.display_name} · {row.username}"} for row in db.execute(
            select(User.id, User.display_name, User.username).order_by(User.id)
        )],
        "DEPARTMENT": [{"id": row.id, "name": row.name} for row in db.execute(
            select(Department.id, Department.name).where(Department.archived.is_(False)).order_by(Department.name)
        )],
        "GROUP": [{"id": row.id, "name": row.name} for row in db.execute(
            select(UserGroup.id, UserGroup.name).order_by(UserGroup.name)
        )],
    }


def visible_to(subject_type, subject_id, user: User):
    groups = select(UserGroupMember.group_id).where(UserGroupMember.user_id == user.id)
    departments = select(Department.id).where(Department.code == user.department, Department.archived.is_(False))
    return or_(
        and_(subject_type == "EVERYONE", subject_id == 0),
        and_(subject_type == "USER", subject_id == user.id),
        and_(subject_type == "DEPARTMENT", subject_id.in_(departments)),
        and_(subject_type == "GROUP", subject_id.in_(groups)),
    )
