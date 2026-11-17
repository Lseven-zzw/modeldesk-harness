from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, union
from sqlalchemy.orm import Session

from app.admin.assignments import Assignment, assignment_view, set_assignments
from app.admin.authorization_audit import record_change
from app.admin.employee_capabilities import employee_capabilities
from app.admin.rbac import (
    PERMISSIONS,
    READ_PREREQUISITES,
    SCOPED_PERMISSIONS,
    effective_permissions,
    forbidden,
    model_permissions,
    model_grant_operations,
    model_grant_sources,
    permission_sources,
)
from app.admin.routes_employees import _get, _lock_active_admins, _no_store
from app.auth.admin_session import require_admin, require_admin_portal, require_csrf
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import (
    AdminRole, AdminRolePermission, AdminUserRole, AuthorizationAudit, Department, ModelRow,
    User, UserGroup, UserGroupMember, UserGroupRole,
)

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(_no_store)])
Root = Annotated[User, Depends(require_admin)]
DB = Annotated[Session, Depends(get_session)]
RoleCode = Annotated[str, Path(pattern=r"^[a-z][a-z0-9_-]{0,47}$")]
CSRF = [Depends(require_csrf)]


class RoleBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    permissions: set[str] = Field(max_length=len(PERMISSIONS))


class AssignmentsBody(BaseModel):
    items: list[Assignment] = Field(max_length=200)


@router.get("/access-options")
def access_options(user: Annotated[User, Depends(require_admin_portal)], db: DB) -> dict:
    permissions = effective_permissions(db, user)
    global_options = permissions.keys() & {"grants.read", "credits.read"}
    scoped_ids = [model_id for model_id, ops in model_permissions(db, user).items() if "grants.read" in ops]
    if not global_options and not scoped_ids:
        raise forbidden()
    model_options = select(ModelRow.id, ModelRow.display_name).order_by(ModelRow.id)
    if not global_options:
        model_options = model_options.where(ModelRow.id.in_(scoped_ids))
    return {
        "models": [
            {"id": row.id, "display_name": row.display_name}
            for row in db.execute(model_options)
        ],
        "departments": [
            {"code": code, "name": name}
            for code, name in db.execute(
                select(Department.code, Department.name).where(Department.archived.is_(False)).order_by(Department.name)
            )
        ],
        "employees": [
            {
                "id": row.id,
                "username": row.username,
                "display_name": row.display_name,
                "department": row.department,
            }
            for row in db.execute(
                select(User.id, User.username, User.display_name, User.department).order_by(User.id)
            )
        ],
    }


@router.get("/roles")
def list_roles(_root: Root, db: DB) -> dict:
    grants: dict[str, list[str]] = {}
    for row in db.scalars(select(AdminRolePermission).order_by(AdminRolePermission.permission)):
        grants.setdefault(row.role_code, []).append(row.permission)
    department_names = dict(db.execute(
        select(Department.code, Department.name).where(Department.archived.is_(False))
    ).all())
    role_members = union(
        select(AdminUserRole.role_code, AdminUserRole.user_id),
        select(UserGroupRole.role_code, UserGroupMember.user_id)
        .join(UserGroupMember, UserGroupMember.group_id == UserGroupRole.group_id),
    ).subquery()
    member_counts = dict(db.execute(
        select(role_members.c.role_code, func.count()).group_by(role_members.c.role_code)
    ).all())
    return {
        "items": [
            {"code": role.code, "name": role.name, "permissions": grants.get(role.code, []),
             "member_count": member_counts.get(role.code, 0)}
            for role in db.scalars(select(AdminRole).order_by(AdminRole.code))
        ],
        "permissions": [
            {
                "code": code,
                "name": name,
                "department_scoped": code in SCOPED_PERMISSIONS,
                "implies": READ_PREREQUISITES.get(code),
            }
            for code, name in PERMISSIONS.items()
        ],
        "departments": sorted(
            set(db.scalars(select(User.department).where(User.department.is_not(None)))) - {""}
            | department_names.keys()
        ),
        "department_names": department_names,
    }


@router.put("/roles/{code}", dependencies=CSRF)
def save_role(code: RoleCode, body: RoleBody, root: Root, db: DB) -> dict:
    name = body.name.strip()
    if not name or not body.permissions <= PERMISSIONS.keys():
        raise ModelDeskError(400, "invalid_request", "角色名称或权限无效")
    _lock_active_admins(db, root.id)
    role = db.get(AdminRole, code, with_for_update=True)
    before = None if role is None else {
        "name": role.name,
        "permissions": sorted(db.scalars(
            select(AdminRolePermission.permission).where(AdminRolePermission.role_code == code)
        )),
    }
    if role is None:
        db.add(AdminRole(code=code, name=name))
        db.flush()
    else:
        role.name = name
    db.execute(delete(AdminRolePermission).where(AdminRolePermission.role_code == code))
    db.add_all(AdminRolePermission(role_code=code, permission=p) for p in body.permissions)
    after = {"name": name, "permissions": sorted(body.permissions)}
    record_change(db, root.id, "role.save", code, before, after)
    db.commit()
    return {"code": code, "name": name, "permissions": sorted(body.permissions)}


@router.delete("/roles/{code}", status_code=204, dependencies=CSRF)
def remove_role(code: RoleCode, root: Root, db: DB) -> Response:
    _lock_active_admins(db, root.id)
    role = db.get(AdminRole, code, with_for_update=True)
    if role is None:
        raise ModelDeskError(404, "invalid_request", "角色不存在")
    record_change(db, root.id, "role.delete", code, {
        "name": role.name,
        "assignments": [list(row) for row in db.execute(
            select(AdminUserRole.user_id, AdminUserRole.department, AdminUserRole.include_descendants)
            .where(AdminUserRole.role_code == code)
            .order_by(AdminUserRole.user_id, AdminUserRole.department)
        )],
        "permissions": sorted(db.scalars(
            select(AdminRolePermission.permission).where(AdminRolePermission.role_code == code)
        )),
        "groups": [list(row) for row in db.execute(
            select(UserGroupRole.group_id, UserGroupRole.department, UserGroupRole.include_descendants)
            .where(UserGroupRole.role_code == code)
            .order_by(UserGroupRole.group_id, UserGroupRole.department)
        )],
    }, None)
    db.execute(delete(AdminUserRole).where(AdminUserRole.role_code == code))
    db.execute(delete(UserGroupRole).where(UserGroupRole.role_code == code))
    db.execute(delete(AdminRolePermission).where(AdminRolePermission.role_code == code))
    db.delete(role)
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/employees/{user_id}/roles")
def list_assignments(user_id: int, _root: Root, db: DB) -> dict:
    if not 0 < user_id <= 2**63 - 1 or db.get(User, user_id) is None:
        raise ModelDeskError(404, "invalid_request", "员工不存在")
    rows = db.scalars(
        select(AdminUserRole)
        .where(AdminUserRole.user_id == user_id)
        .order_by(AdminUserRole.role_code, AdminUserRole.department)
    )
    return {
        "items": [assignment_view(row.role_code, row.department, row.include_descendants) for row in rows]
    }


@router.put("/employees/{user_id}/roles", dependencies=CSRF)
def replace_assignments(user_id: int, body: AssignmentsBody, root: Root, db: DB) -> dict:
    _lock_active_admins(db, root.id)
    target = _get(db, user_id)
    if target.role == "ADMIN":
        raise ModelDeskError(400, "invalid_request", "超级管理员已拥有全部权限")
    pairs = set_assignments(db, target, body.items, root.id)
    db.commit()
    return {
        "items": [assignment_view(*item) for item in sorted(pairs)]
    }


@router.get("/employees/{user_id}/effective-permissions")
def explain_employee_permissions(user_id: int, _root: Root, db: DB) -> dict:
    user = db.get(User, user_id) if 0 < user_id <= 2**63 - 1 else None
    if user is None:
        raise ModelDeskError(404, "invalid_request", "员工不存在")
    sources = sorted(
        permission_sources(db, user) if user.status == 1 else (),
        key=lambda row: (row[0], row[1] or "", row[2] or "", row[3], row[4] or 0, row[5] or ""),
    )
    roles = {role for _, _, role, _, _, _ in sources if role is not None}
    departments = {code for _, department, _, _, _, root in sources for code in (department, root) if code is not None}
    groups = {group_id for _, _, _, _, group_id, _ in sources if group_id is not None}
    role_names = dict(db.execute(select(AdminRole.code, AdminRole.name).where(AdminRole.code.in_(roles))).all())
    department_names = dict(db.execute(
        select(Department.code, Department.name).where(Department.code.in_(departments))
    ).all())
    group_names = dict(db.execute(select(UserGroup.id, UserGroup.name).where(UserGroup.id.in_(groups))).all())
    model_grants = model_grant_sources(db, user) if user.status == 1 else []
    model_ids = {grant.model_id for grant in model_grants}
    model_names = dict(db.execute(select(ModelRow.id, ModelRow.display_name).where(ModelRow.id.in_(model_ids))).all())
    model_subject_names = {"USER": {user.id: user.display_name}}
    for kind, table in (("DEPARTMENT", Department), ("GROUP", UserGroup)):
        ids = {grant.subject_id for grant in model_grants if grant.subject_type == kind}
        model_subject_names[kind] = dict(db.execute(select(table.id, table.name).where(table.id.in_(ids))).all())
    return {"active": user.status == 1, "capabilities": employee_capabilities(db, user), "model_items": [
        {"model_id": grant.model_id, "model_name": model_names[grant.model_id], "permission": permission,
         "name": PERMISSIONS[permission], "subject_type": grant.subject_type, "subject_id": grant.subject_id,
         "subject_name": model_subject_names.get(grant.subject_type, {}).get(grant.subject_id),
         "granted_permission": grant.permission, "include_descendants": grant.include_descendants}
        for grant in sorted(model_grants, key=lambda row: (row.model_id, row.subject_type, row.subject_id, row.permission))
        if grant.model_id in model_names for permission in sorted(model_grant_operations(grant.permission))
    ], "items": [
        {"permission": permission, "name": PERMISSIONS.get(permission, "管理角色与授权"),
         "department": department, "department_name": department_names.get(department),
         "role": role, "role_name": role_names.get(role), "granted_permission": granted,
         "group_id": group_id, "group_name": group_names.get(group_id),
         "scope_root": scope_root, "scope_root_name": department_names.get(scope_root)}
        for permission, department, role, granted, group_id, scope_root in sources
    ]}


@router.get("/authorization-audit")
def list_authorization_audit(
    _root: Root, db: DB, before: Annotated[int | None, Query(gt=0)] = None,
) -> dict:
    statement = select(AuthorizationAudit).order_by(AuthorizationAudit.id.desc()).limit(51)
    if before is not None:
        statement = statement.where(AuthorizationAudit.id < before)
    rows = list(db.scalars(statement))
    return {"items": [
        {"id": row.id, "actor_id": row.actor_id, "action": row.action, "target": row.target,
         "details": row.details, "created_at": row.created_at.isoformat() + "Z"}
        for row in rows[:50]
    ], "next_before": rows[49].id if len(rows) > 50 else None}
