from dataclasses import dataclass

from collections import defaultdict

from sqlalchemy import and_, literal, or_, select, true, union_all
from sqlalchemy.orm import Session

from app.common.errors import ModelDeskError
from app.models import (
    AdminRolePermission, AdminUserRole, Department, ModelAdminGrant, User, UserGroupMember, UserGroupRole,
)

PERMISSIONS = {
    "employees.read": "查看员工",
    "employees.create": "创建员工",
    "employees.update": "编辑员工",
    "employees.status": "启用或停用员工",
    "employees.password": "重置员工密码",
    "models.read": "查看模型配置",
    "models.create": "新增模型",
    "models.update": "编辑模型配置",
    "models.status": "启用或停用模型",
    "grants.read": "查看模型开放范围",
    "grants.write": "管理模型开放范围",
    "credits.read": "查看额度规则",
    "credits.create": "新增额度规则",
    "credits.delete": "删除额度规则",
    "usage.read": "查看用量与调用记录",
    "skills.read": "查看企业技能",
    "skills.edit": "创建与编辑企业技能草稿",
    "skills.publish": "发布与下架企业技能",
    "documents.read": "查看企业资料库",
    "documents.manage": "维护企业资料和开放范围",
    "mcp.read": "查看企业 MCP 配置",
    "mcp.manage": "维护企业 MCP 和工具开放范围",
}
SCOPED_PERMISSIONS = frozenset(
    permission
    for permission in PERMISSIONS
    if permission.startswith("employees.") or permission == "usage.read"
)
READ_PREREQUISITES = {
    "employees.create": "employees.read",
    "employees.update": "employees.read",
    "employees.status": "employees.read",
    "employees.password": "employees.read",
    "models.create": "models.read",
    "models.update": "models.read",
    "models.status": "models.read",
    "grants.write": "grants.read",
    "credits.create": "credits.read",
    "credits.delete": "credits.read",
    "skills.edit": "skills.read",
    "skills.publish": "skills.read",
    "documents.manage": "documents.read",
    "mcp.manage": "mcp.read",
}
ROOT_PERMISSION = "roles.manage"
MODEL_OPERATIONS = frozenset({"models.read", "models.update", "models.status", "grants.read", "grants.write"})


def forbidden() -> ModelDeskError:
    return ModelDeskError(403, "permission_denied", "没有执行此操作的权限")


@dataclass(frozen=True)
class Access:
    user: User
    departments: frozenset[str] | None

    def check_department(self, department: str | None) -> None:
        if self.departments is not None and department not in self.departments:
            raise forbidden()

    def check_employee(self, db: Session, target: User) -> None:
        if self.user.role != "ADMIN" and (
            target.role == "ADMIN"
            or db.scalar(
                select(AdminUserRole.user_id)
                .where(AdminUserRole.user_id == target.id)
                .limit(1)
                .with_for_update()
            )
            is not None
            or bool(model_grant_sources(db, target, lock=True))
            or db.scalar(
                select(UserGroupMember.user_id)
                .join(UserGroupRole, UserGroupRole.group_id == UserGroupMember.group_id)
                .where(UserGroupMember.user_id == target.id)
                .limit(1)
                .with_for_update()
            )
            is not None
        ):
            raise forbidden()
        self.check_department(target.department)

    def check_department_assignment(self, db: Session, department: str | None) -> None:
        if self.user.role != "ADMIN" and department and _department_model_grants(db, department, lock=True):
            raise forbidden()


def permission_sources(db: Session, user: User):
    if user.role == "ADMIN":
        for permission in [*PERMISSIONS, ROOT_PERMISSION]:
            yield permission, None, None, permission, None, None
        return
    direct = (
        select(AdminRolePermission.permission, AdminUserRole.department, AdminUserRole.role_code,
               literal(None), AdminUserRole.include_descendants)
        .join(AdminUserRole, AdminUserRole.role_code == AdminRolePermission.role_code)
        .where(AdminUserRole.user_id == user.id)
    )
    grouped = (
        select(AdminRolePermission.permission, UserGroupRole.department, UserGroupRole.role_code,
               UserGroupRole.group_id, UserGroupRole.include_descendants)
        .join(UserGroupRole, UserGroupRole.role_code == AdminRolePermission.role_code)
        .join(UserGroupMember, UserGroupMember.group_id == UserGroupRole.group_id)
        .where(UserGroupMember.user_id == user.id)
    )
    rows = list(db.execute(union_all(direct, grouped)))
    inherited = _descendant_scopes(db, {department for _, department, _, _, include in rows if include})
    for permission, department, role_code, group_id, include in rows:
        if permission not in PERMISSIONS:
            continue
        for allowed in sorted({permission, READ_PREREQUISITES.get(permission, permission)}):
            if not department or allowed in SCOPED_PERMISSIONS:
                for scoped in inherited.get(department, ()) if include else (department,):
                    yield allowed, scoped or None, role_code, permission, group_id, department if include else None


def _descendant_scopes(db: Session, roots: set[str]) -> dict[str, set[str]]:
    if not roots:
        return {}
    ids = {}
    children: dict[int, list[tuple[int, str]]] = defaultdict(list)
    for department_id, code, parent_id in db.execute(
        select(Department.id, Department.code, Department.parent_id).where(Department.archived.is_(False))
    ):
        ids[code] = department_id
        if parent_id is not None:
            children[parent_id].append((department_id, code))
    result = {}
    for root in roots & ids.keys():
        seen = {root}
        pending = [ids[root]]
        while pending:
            for child_id, child_code in children[pending.pop()]:
                if child_code not in seen:
                    seen.add(child_code)
                    pending.append(child_id)
        result[root] = seen
    return result


def effective_permissions(db: Session, user: User) -> dict[str, frozenset[str] | None]:
    result: dict[str, frozenset[str] | None] = {}
    for permission, department, _, _, _, _ in permission_sources(db, user):
        if department is None:
            result[permission] = None
        elif (scope := result.get(permission, frozenset())) is not None:
            result[permission] = scope | {department}
    return result


def department_filter(db: Session, departments: frozenset[str] | None):
    if departments is None:
        return true()
    collation = "utf8mb4_bin" if db.get_bind().dialect.name == "mysql" else "BINARY"
    return User.department.collate(collation).in_(departments)


def _department_model_grants(db: Session, code: str, *, lock: bool = False):
    statement = select(Department.id, Department.parent_id).where(
        Department.code == code, Department.archived.is_(False)
    )
    if lock:
        statement = statement.with_for_update()
    match = db.execute(statement).one_or_none()
    if match is None:
        return []
    department_id, parent_id = match
    ancestors = set()
    while parent_id is not None and parent_id != department_id and parent_id not in ancestors:
        statement = select(Department.id, Department.parent_id).where(
            Department.id == parent_id, Department.archived.is_(False)
        )
        if lock:
            statement = statement.with_for_update()
        match = db.execute(statement).one_or_none()
        if match is None:
            break
        ancestor_id, parent_id = match
        ancestors.add(ancestor_id)
    query = select(ModelAdminGrant).where(
        ModelAdminGrant.subject_type == "DEPARTMENT",
        or_(ModelAdminGrant.subject_id == department_id,
            and_(ModelAdminGrant.subject_id.in_(ancestors), ModelAdminGrant.include_descendants.is_(True))),
    )
    return list(db.scalars(query.with_for_update() if lock else query))


def model_grant_sources(db: Session, user: User, *, lock: bool = False) -> list[ModelAdminGrant]:
    if user.role == "ADMIN":
        return []
    groups = select(UserGroupMember.group_id).where(UserGroupMember.user_id == user.id)
    if lock:
        groups = groups.with_for_update()
    query = select(ModelAdminGrant).where(or_(
        and_(ModelAdminGrant.subject_type == "USER", ModelAdminGrant.subject_id == user.id),
        and_(ModelAdminGrant.subject_type == "GROUP", ModelAdminGrant.subject_id.in_(groups)),
    ))
    direct_and_group = list(db.scalars(query.with_for_update() if lock else query))
    return direct_and_group + (_department_model_grants(db, user.department, lock=lock) if user.department else [])


def model_permissions(db: Session, user: User) -> dict[int, set[str]]:
    result: dict[int, set[str]] = defaultdict(set)
    for grant in model_grant_sources(db, user):
        operations = model_grant_operations(grant.permission)
        if operations:
            result[grant.model_id].update(operations)
    return result


def model_grant_operations(permission: str) -> set[str]:
    return {permission, READ_PREREQUISITES.get(permission, permission)} if permission in MODEL_OPERATIONS else set()


def can_access_admin(db: Session, user: User) -> bool:
    return bool(effective_permissions(db, user) or model_permissions(db, user))
