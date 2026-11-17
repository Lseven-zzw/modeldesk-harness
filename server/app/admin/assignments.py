from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.admin.authorization_audit import record_change
from app.common.errors import ModelDeskError
from app.models import AdminRole, AdminUserRole, Department, User


class Assignment(BaseModel):
    role: str = Field(min_length=1, max_length=48)
    department: str | None = Field(default=None, max_length=100)
    include_descendants: bool = False

    @field_validator("department")
    @classmethod
    def normalize_department(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip():
            raise ValueError("使用 null 表示全局授权")
        return value.strip()


AssignmentKey = tuple[str, str, bool]


def assignment_view(role: str, department: str, include_descendants: bool) -> dict:
    return {
        "role": role, "department": department or None,
        **({"include_descendants": True} if include_descendants else {}),
    }


def validated_assignments(db: Session, items: list[Assignment]) -> set[AssignmentKey]:
    pairs = {(item.role, item.department or "") for item in items}
    roles = {role for role, _ in pairs}
    departments = {department for _, department in pairs if department}
    known_roles = set(db.scalars(select(AdminRole.code).where(AdminRole.code.in_(roles))))
    if any(department and (role, "") in pairs for role, department in pairs):
        raise ModelDeskError(400, "invalid_request", "同一角色不能同时授予全局和部门范围")
    registered = dict(db.execute(
        select(Department.code, Department.archived).where(Department.code.in_(departments))
        .with_for_update()
    ).all())
    active = {code for code, archived in registered.items() if not archived}
    legacy = set(db.scalars(select(User.department).where(User.department.in_(departments))))
    known_departments = active | (legacy - registered.keys())
    if len(pairs) != len(items) or roles != known_roles or departments != known_departments:
        raise ModelDeskError(400, "invalid_request", "角色或部门不存在，或授权重复")
    if any(item.include_descendants and item.department not in active for item in items):
        raise ModelDeskError(400, "invalid_request", "只有已登记的有效部门可授权下级")
    return {(item.role, item.department or "", item.include_descendants) for item in items}


def set_assignments(
    db: Session, target: User, items: list[Assignment], actor_id: int
) -> set[AssignmentKey]:
    if target.role == "ADMIN" and items:
        raise ModelDeskError(400, "invalid_request", "超级管理员已拥有全部权限")
    pairs = validated_assignments(db, items)
    before = sorted(tuple(row) for row in db.execute(
        select(AdminUserRole.role_code, AdminUserRole.department, AdminUserRole.include_descendants)
        .where(AdminUserRole.user_id == target.id)
    ))
    record_change(db, actor_id, "employee.roles", str(target.id), before, sorted(pairs))
    db.execute(delete(AdminUserRole).where(AdminUserRole.user_id == target.id))
    db.add_all(
        AdminUserRole(user_id=target.id, role_code=role, department=department,
                      include_descendants=include_descendants)
        for role, department, include_descendants in pairs
    )
    return pairs
