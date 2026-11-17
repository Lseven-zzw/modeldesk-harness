import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.admin.assignments import Assignment, set_assignments
from app.admin.authorization_audit import record_change
from app.admin.rbac import Access, department_filter, effective_permissions, forbidden, model_permissions
from app.auth.admin_session import require_admin_portal, require_csrf, require_permission
from app.common.clock import utcnow
from app.common.errors import ModelDeskError
from app.common.passwords import hash_password
from app.db import get_session
from app.departments import register_legacy_department
from app.models import SessionRow, User
from app.settings import get_settings


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(_no_store)])
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")


class EmployeeCreate(BaseModel):
    username: str
    display_name: str
    department: str | None = None
    role: Literal["EMPLOYEE", "ADMIN"] = "EMPLOYEE"
    password: str
    assignments: list[Assignment] | None = Field(default=None, max_length=200)


class EmployeePatch(BaseModel):
    display_name: str | None = None
    department: str | None = None
    role: Literal["EMPLOYEE", "ADMIN"] | None = None
    assignments: list[Assignment] | None = Field(default=None, max_length=200)


class StatusBody(BaseModel):
    status: Literal[0, 1]


class PasswordBody(BaseModel):
    password: str


def _password(value: str) -> str:
    if len(value) < 12:
        raise ModelDeskError(400, "invalid_request", "密码至少 12 位")
    if len(value) > 128:
        raise ModelDeskError(400, "invalid_request", "密码不能超过 128 位")
    return value


def _department(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    if len(cleaned) > 100:
        raise ModelDeskError(400, "invalid_request", "部门名称不能超过 100 字")
    return cleaned or None


def _display_name(value: str) -> str:
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 100:
        raise ModelDeskError(400, "invalid_request", "姓名不能为空且不超过 100 字")
    return cleaned


def _view(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "department": user.department,
        "role": user.role,
        "status": user.status,
        "created_at": user.created_at.isoformat(),
    }


def _get(db: Session, user_id: int) -> User:
    user = (
        db.get(User, user_id, with_for_update=True, populate_existing=True)
        if 0 < user_id <= 2**63 - 1
        else None
    )
    if user is None:
        raise ModelDeskError(404, "invalid_request", "员工不存在")
    return user


def _revoke_sessions(db: Session, user_id: int) -> None:
    db.execute(
        update(SessionRow)
        .where(SessionRow.user_id == user_id, SessionRow.status == "ACTIVE")
        .values(status="REVOKED")
    )


def _lock_active_admins(db: Session, actor_id: int) -> set[int]:
    admin_ids = set(
        db.scalars(
            select(User.id)
            .where(User.role == "ADMIN", User.status == 1)
            .order_by(User.id)
            .with_for_update()
        )
    )
    if actor_id not in admin_ids:
        raise ModelDeskError(403, "invalid_request", "管理台仅对启用的管理员开放")
    return admin_ids


@router.get("/session")
def session_view(
    request: Request,
    admin: Annotated[User, Depends(require_admin_portal)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    return {
        "user": _view(admin),
        "csrf_token": request.session.get("csrf", ""),
        "org_name": get_settings().org_name,
        "permissions": sorted(effective_permissions(db, admin)),
        "model_permissions": {model_id: sorted(operations) for model_id, operations in model_permissions(db, admin).items()},
    }


@router.get("/employees")
def list_employees(
    access: Annotated[Access, Depends(require_permission("employees.read"))],
    db: Annotated[Session, Depends(get_session)],
    q: str = "",
    page: int = 1,
    page_size: int = 50,
) -> dict:
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    stmt = select(User).where(department_filter(db, access.departments))
    if q.strip():
        stmt = stmt.where(
            or_(
                User.username.contains(q.strip(), autoescape=True),
                User.display_name.contains(q.strip(), autoescape=True),
                User.department.contains(q.strip(), autoescape=True),
            )
        )
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    offset = (page - 1) * page_size
    rows = (
        db.scalars(stmt.order_by(User.id).offset(offset).limit(page_size)).all()
        if offset < total
        else []
    )
    return {
        "items": [_view(user) for user in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/employees", status_code=201)
def create_employee(
    body: EmployeeCreate,
    access: Annotated[Access, Depends(require_permission("employees.create"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    if body.role == "ADMIN" or body.assignments is not None:
        if access.user.role != "ADMIN":
            raise forbidden()
        _lock_active_admins(db, access.user.id)
    department = _department(body.department)
    access.check_department(department)
    access.check_department_assignment(db, department)
    if not USERNAME_RE.fullmatch(body.username):
        raise ModelDeskError(
            400, "invalid_request", "用户名只能是小写字母、数字、点、下划线或连字符（3–64 位）"
        )
    if db.scalar(select(User.id).where(User.username == body.username)) is not None:
        raise ModelDeskError(400, "invalid_request", "用户名已存在")
    user = User(
        username=body.username,
        display_name=_display_name(body.display_name),
        department=department,
        role=body.role,
        status=1,
        password_hash=hash_password(_password(body.password)),
        created_at=utcnow(),
    )
    db.add(user)
    try:
        db.flush()
        register_legacy_department(db, department)
        if body.assignments is not None:
            set_assignments(db, user, body.assignments, access.user.id)
        if user.role == "ADMIN":
            record_change(db, access.user.id, "employee.identity", str(user.id), None, user.role)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if db.scalar(select(User.id).where(User.username == body.username)) is None:
            raise
        raise ModelDeskError(400, "invalid_request", "用户名已存在") from exc
    return _view(user)


@router.patch("/employees/{user_id}")
def patch_employee(
    user_id: int,
    body: EmployeePatch,
    access: Annotated[Access, Depends(require_permission("employees.update"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    admin = access.user
    if body.assignments is not None and admin.role != "ADMIN":
        raise forbidden()
    active_admins = _lock_active_admins(db, admin.id) if admin.role == "ADMIN" else set()
    user = _get(db, user_id)
    access.check_employee(db, user)
    if body.role == "ADMIN" and admin.role != "ADMIN":
        raise forbidden()
    if body.role == "EMPLOYEE" and user.id == admin.id:
        raise ModelDeskError(400, "invalid_request", "不能取消自己的管理员角色")
    if body.role == "EMPLOYEE" and user.role == "ADMIN" and active_admins == {user.id}:
        raise ModelDeskError(400, "invalid_request", "至少保留一名启用的管理员")
    if body.display_name is not None:
        user.display_name = _display_name(body.display_name)
    if "department" in body.model_fields_set:
        department = _department(body.department)
        access.check_department(department)
        if department != user.department:
            access.check_department_assignment(db, department)
        record_change(db, admin.id, "employee.department", str(user.id), user.department, department)
        user.department = department
    if body.role is not None:
        record_change(db, admin.id, "employee.identity", str(user.id), user.role, body.role)
        user.role = body.role
    db.flush()
    if "department" in body.model_fields_set:
        register_legacy_department(db, user.department)
    if body.assignments is not None:
        set_assignments(db, user, body.assignments, admin.id)
    db.commit()
    return _view(user)


@router.post("/employees/{user_id}/status")
def set_status(
    user_id: int,
    body: StatusBody,
    access: Annotated[Access, Depends(require_permission("employees.status"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    admin = access.user
    active_admins = _lock_active_admins(db, admin.id) if admin.role == "ADMIN" else set()
    user = _get(db, user_id)
    access.check_employee(db, user)
    if user.id == admin.id and body.status == 0:
        raise ModelDeskError(400, "invalid_request", "不能停用自己")
    if body.status == 0 and user.role == "ADMIN" and active_admins == {user.id}:
        raise ModelDeskError(400, "invalid_request", "至少保留一名启用的管理员")
    record_change(db, admin.id, "employee.status", str(user.id), user.status, body.status)
    user.status = body.status
    if body.status == 0:
        _revoke_sessions(db, user.id)
    db.commit()
    return _view(user)


@router.post("/employees/{user_id}/password", status_code=204)
def reset_password(
    user_id: int,
    body: PasswordBody,
    access: Annotated[Access, Depends(require_permission("employees.password"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> Response:
    user = _get(db, user_id)
    access.check_employee(db, user)
    user.password_hash = hash_password(_password(body.password))
    _revoke_sessions(db, user.id)
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
