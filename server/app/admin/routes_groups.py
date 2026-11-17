from typing import Annotated

from fastapi import APIRouter, Depends, Path, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.admin.assignments import Assignment, AssignmentKey, assignment_view, validated_assignments
from app.admin.authorization_audit import record_change
from app.admin.routes_employees import _lock_active_admins, _no_store
from app.auth.admin_session import require_admin, require_csrf
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import EnterpriseSkillGrant, ModelAdminGrant, ModelRow, User, UserGroup, UserGroupMember, UserGroupRole

router = APIRouter(prefix="/api/admin/user-groups", tags=["admin"], dependencies=[Depends(_no_store)])
Root = Annotated[User, Depends(require_admin)]
DB = Annotated[Session, Depends(get_session)]
GroupId = Annotated[int, Path(gt=0, le=2**63 - 1)]
MemberId = Annotated[int, Field(gt=0, le=2**63 - 1)]
CSRF = [Depends(require_csrf)]


class GroupBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    member_ids: set[MemberId] = Field(max_length=500)
    assignments: list[Assignment] = Field(max_length=200)


def _get(db: Session, group_id: int) -> UserGroup:
    group = db.get(UserGroup, group_id, with_for_update=True)
    if group is None:
        raise ModelDeskError(404, "invalid_request", "用户组不存在")
    return group


def _view(group: UserGroup, members: set[int], roles: set[AssignmentKey]) -> dict:
    return {"id": group.id, "name": group.name, "member_ids": sorted(members), "assignments": [
        assignment_view(*item) for item in sorted(roles)
    ]}


def _contents(db: Session, group_id: int) -> tuple[set[int], set[AssignmentKey]]:
    members = set(db.scalars(select(UserGroupMember.user_id).where(UserGroupMember.group_id == group_id)))
    roles = {tuple(row) for row in db.execute(
        select(UserGroupRole.role_code, UserGroupRole.department, UserGroupRole.include_descendants)
        .where(UserGroupRole.group_id == group_id)
    )}
    return members, roles


@router.get("")
def list_groups(_root: Root, db: DB) -> dict:
    members: dict[int, set[int]] = {}
    roles: dict[int, set[AssignmentKey]] = {}
    for group_id, user_id in db.execute(select(UserGroupMember.group_id, UserGroupMember.user_id)):
        members.setdefault(group_id, set()).add(user_id)
    for group_id, role, department, include in db.execute(
        select(UserGroupRole.group_id, UserGroupRole.role_code, UserGroupRole.department, UserGroupRole.include_descendants)
    ):
        roles.setdefault(group_id, set()).add((role, department, include))
    return {"items": [
        _view(group, members.get(group.id, set()), roles.get(group.id, set()))
        for group in db.scalars(select(UserGroup).order_by(UserGroup.name, UserGroup.id))
    ]}


def _save(db: Session, root: User, body: GroupBody, group: UserGroup | None) -> dict:
    name = body.name.strip()
    if not name:
        raise ModelDeskError(400, "invalid_request", "用户组名称不能为空")
    roles = validated_assignments(db, body.assignments)
    members, old_roles = _contents(db, group.id) if group is not None else (set(), set())
    # Coordinate with employee edits and password resets, which lock the same users.
    locked = set(db.scalars(
        select(User.id).where(User.id.in_(members | body.member_ids)).order_by(User.id).with_for_update()
    ))
    if not body.member_ids <= locked:
        raise ModelDeskError(400, "invalid_request", "部分员工不存在")
    before = None if group is None else _view(group, members, old_roles)
    if group is None:
        group = UserGroup(name=name)
        db.add(group)
    else:
        group.name = name
    try:
        db.flush()
        after = _view(group, body.member_ids, roles)
        if before != after:
            _delete_links(db, group.id)
            db.add_all(UserGroupMember(group_id=group.id, user_id=user_id) for user_id in body.member_ids)
            db.add_all(UserGroupRole(group_id=group.id, role_code=role, department=department,
                                     include_descendants=include)
                       for role, department, include in roles)
            record_change(db, root.id, "group.save", str(group.id), before, after)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ModelDeskError(409, "invalid_request", "用户组名称已存在") from exc
    return after


def _delete_links(db: Session, group_id: int) -> None:
    db.execute(delete(UserGroupMember).where(UserGroupMember.group_id == group_id))
    db.execute(delete(UserGroupRole).where(UserGroupRole.group_id == group_id))


@router.post("", status_code=201, dependencies=CSRF)
def create_group(body: GroupBody, root: Root, db: DB) -> dict:
    _lock_active_admins(db, root.id)
    return _save(db, root, body, None)


@router.put("/{group_id}", dependencies=CSRF)
def update_group(group_id: GroupId, body: GroupBody, root: Root, db: DB) -> dict:
    _lock_active_admins(db, root.id)
    return _save(db, root, body, _get(db, group_id))


@router.delete("/{group_id}", status_code=204, dependencies=CSRF)
def delete_group(group_id: GroupId, root: Root, db: DB) -> Response:
    _lock_active_admins(db, root.id)
    group = _get(db, group_id)
    if db.scalar(select(EnterpriseSkillGrant.code).where(
        EnterpriseSkillGrant.subject_type == "GROUP", EnterpriseSkillGrant.subject_id == group_id,
    ).limit(1).with_for_update()) is not None:
        raise ModelDeskError(409, "invalid_request", "请先移除该组的企业技能授权")
    members, roles = _contents(db, group.id)
    group_grants = (ModelAdminGrant.subject_type == "GROUP", ModelAdminGrant.subject_id == group_id)
    grants = [list(row) for row in db.execute(
        select(ModelAdminGrant.model_id, ModelAdminGrant.permission).where(*group_grants)
        .order_by(ModelAdminGrant.model_id, ModelAdminGrant.permission).with_for_update()
    )]
    if grants:
        db.execute(update(ModelRow).where(ModelRow.id.in_({model_id for model_id, _ in grants}))
                   .values(delegation_revision=ModelRow.delegation_revision + 1))
        db.execute(delete(ModelAdminGrant).where(*group_grants))
    record_change(db, root.id, "group.delete", str(group.id),
                  {**_view(group, members, roles), "model_grants": grants}, None)
    _delete_links(db, group.id)
    db.delete(group)
    db.commit()
    return Response(status_code=204)
