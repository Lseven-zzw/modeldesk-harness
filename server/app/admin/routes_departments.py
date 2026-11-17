from typing import Annotated

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.admin.authorization_audit import record_change
from app.admin.rbac import department_filter, effective_permissions, forbidden
from app.admin.routes_employees import _lock_active_admins, _no_store
from app.auth.admin_session import require_admin, require_admin_portal, require_csrf
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import AdminUserRole, CreditRule, Department, EnterpriseSkillGrant, ModelAdminGrant, ModelGrant, User, UserGroupRole

router = APIRouter(prefix="/api/admin/departments", tags=["admin"], dependencies=[Depends(_no_store)])
DB = Annotated[Session, Depends(get_session)]
Root = Annotated[User, Depends(require_admin)]
DepartmentId = Annotated[int, Path(gt=0, le=2**63 - 1)]
CSRF = [Depends(require_csrf)]


class DepartmentName(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    parent_id: int | None = Field(default=None, gt=0, le=2**63 - 1)


class DepartmentCreate(DepartmentName):
    code: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")


class DepartmentStatus(BaseModel):
    archived: bool


def _name(body: DepartmentName) -> str:
    name = body.name.strip()
    if not name:
        raise ModelDeskError(400, "invalid_request", "部门名称不能为空")
    return name


def _view(row: Department, members: int = 0) -> dict:
    return {"id": row.id, "code": row.code, "name": row.name, "parent_id": row.parent_id,
            "members": members, "archived": row.archived}


def _validate_parent(db: Session, parent_id: int | None, moving_id: int | None = None) -> None:
    visited = {moving_id}
    while parent_id is not None:
        if parent_id in visited:
            raise ModelDeskError(400, "invalid_request", "部门不能移动到自己或其下级部门")
        visited.add(parent_id)
        parent = db.get(Department, parent_id, with_for_update=True)
        if parent is None or parent.archived:
            raise ModelDeskError(400, "invalid_request", "上级部门不存在或已归档")
        parent_id = parent.parent_id


@router.get("")
def list_departments(user: Annotated[User, Depends(require_admin_portal)], db: DB) -> dict:
    permissions = effective_permissions(db, user)
    if "employees.read" not in permissions:
        raise forbidden()
    scope = permissions["employees.read"]
    # MySQL's user table defaults to case-insensitive comparison.
    collation = "utf8mb4_bin" if db.get_bind().dialect.name == "mysql" else "BINARY"
    code = User.department.collate(collation)
    counts = (
        select(code, func.count(User.id))
        .where(User.department.is_not(None), department_filter(db, scope))
        .group_by(code)
    )
    members = dict(db.execute(counts).all())
    query = select(Department).order_by(Department.name, Department.id)
    if scope is not None:
        query = query.where(Department.code.in_(scope))
    if user.role != "ADMIN":
        query = query.where(Department.archived.is_(False))
    return {"items": [_view(row, members.get(row.code, 0)) for row in db.scalars(query)]}


@router.post("", status_code=201, dependencies=CSRF)
def create_department(body: DepartmentCreate, root: Root, db: DB) -> dict:
    _lock_active_admins(db, root.id)
    _validate_parent(db, body.parent_id)
    row = Department(code=body.code, name=_name(body), parent_id=body.parent_id, archived=False)
    db.add(row)
    try:
        db.flush()
        record_change(db, root.id, "department.create", row.code, None, {
            "name": row.name, "parent_id": row.parent_id,
        })
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ModelDeskError(409, "invalid_request", "部门标识已存在") from exc
    return _view(row)


@router.patch("/{department_id}", dependencies=CSRF)
def rename_department(department_id: DepartmentId, body: DepartmentName, root: Root, db: DB) -> dict:
    _lock_active_admins(db, root.id)
    row = db.get(Department, department_id, with_for_update=True)
    if row is None:
        raise ModelDeskError(404, "invalid_request", "部门不存在")
    if row.archived:
        raise ModelDeskError(409, "invalid_request", "请恢复部门后再编辑")
    name = _name(body)
    parent_id = body.parent_id if "parent_id" in body.model_fields_set else row.parent_id
    if parent_id != row.parent_id:
        _validate_parent(db, parent_id, row.id)
        record_change(db, root.id, "department.move", row.code, row.parent_id, parent_id)
        row.parent_id = parent_id
    record_change(db, root.id, "department.rename", row.code, row.name, name)
    row.name = name
    db.commit()
    return {key: value for key, value in _view(row).items() if key != "members"}


@router.put("/{department_id}/status", dependencies=CSRF)
def set_department_status(department_id: DepartmentId, body: DepartmentStatus, root: Root, db: DB) -> dict:
    _lock_active_admins(db, root.id)
    row = db.get(Department, department_id, with_for_update=True)
    if row is None:
        raise ModelDeskError(404, "invalid_request", "部门不存在")
    if row.archived == body.archived:
        return {"archived": row.archived}
    if body.archived:
        collation = "utf8mb4_bin" if db.get_bind().dialect.name == "mysql" else "BINARY"
        references = (
            (select(Department.id).where(Department.parent_id == row.id, Department.archived.is_(False)), "下级部门"),
            (select(User.id).where(User.department.collate(collation) == row.code), "员工"),
            (select(AdminUserRole.user_id).where(AdminUserRole.department == row.code), "员工角色授权"),
            (select(UserGroupRole.group_id).where(UserGroupRole.department == row.code), "用户组角色授权"),
            (select(ModelAdminGrant.model_id).where(ModelAdminGrant.subject_type == "DEPARTMENT",
                                                    ModelAdminGrant.subject_id == row.id), "模型管理授权"),
            (select(EnterpriseSkillGrant.code).where(EnterpriseSkillGrant.subject_type == "DEPARTMENT",
                                                    EnterpriseSkillGrant.subject_id == row.id), "企业技能授权"),
            (select(ModelGrant.id).where(ModelGrant.subject_type == "DEPARTMENT",
                                         ModelGrant.subject_id.collate(collation) == row.code), "模型开放范围"),
            (select(CreditRule.id).where(CreditRule.subject_type == "DEPARTMENT",
                                        CreditRule.subject_id.collate(collation) == row.code), "额度规则"),
        )
        for statement, label in references:
            if db.scalar(statement.limit(1).with_for_update()) is not None:
                raise ModelDeskError(409, "invalid_request", f"部门仍有关联的{label}，请先迁移或解除关联")
    else:
        _validate_parent(db, row.parent_id, row.id)
    record_change(db, root.id, "department.archive" if body.archived else "department.restore",
                  row.code, row.archived, body.archived)
    row.archived = body.archived
    db.commit()
    return {"archived": row.archived}
