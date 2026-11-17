import hmac
import secrets
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.admin.rbac import Access, can_access_admin, effective_permissions, forbidden, model_permissions
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import User

CSRF_KEY = "csrf"


def csrf_token(request: Request) -> str:
    if CSRF_KEY not in request.session:
        request.session[CSRF_KEY] = secrets.token_urlsafe(24)
    return request.session[CSRF_KEY]


def start_admin_session(request: Request, user: User) -> str:
    request.session.clear()
    request.session["uid"] = user.id
    return csrf_token(request)


def clear_admin_session(request: Request) -> None:
    request.session.clear()


def browser_user(request: Request, db: Session) -> User | None:
    uid = request.session.get("uid")
    user = db.get(User, uid) if isinstance(uid, int) else None
    return user if user is not None and user.status == 1 else None


def require_browser_user(request: Request, db: Annotated[Session, Depends(get_session)]) -> User:
    user = browser_user(request, db)
    if user is None:
        raise ModelDeskError(401, "invalid_request", "请先登录")
    return user


def require_admin(user: Annotated[User, Depends(require_browser_user)]) -> User:
    if user.role != "ADMIN":
        raise ModelDeskError(403, "invalid_request", "管理台仅对启用的管理员开放")
    return user


def require_admin_portal(
    user: Annotated[User, Depends(require_browser_user)],
    db: Annotated[Session, Depends(get_session)],
) -> User:
    if not can_access_admin(db, user):
        raise forbidden()
    return user


def require_permission(permission: str):
    def check(
        user: Annotated[User, Depends(require_browser_user)],
        db: Annotated[Session, Depends(get_session)],
    ) -> Access:
        permissions = effective_permissions(db, user)
        if permission not in permissions:
            raise forbidden()
        return Access(user, permissions[permission])

    return check


def require_model_permission(permission: str):
    def check(
        model_id: int,
        user: Annotated[User, Depends(require_browser_user)],
        db: Annotated[Session, Depends(get_session)],
    ) -> Access:
        if permission not in effective_permissions(db, user) and permission not in model_permissions(db, user).get(model_id, ()):
            raise forbidden()
        return Access(user, None)

    return check


def require_csrf(request: Request) -> None:
    supplied = request.headers.get("x-csrf-token") or getattr(request.state, "form_csrf", None)
    check_csrf(request, supplied)


def check_csrf(request: Request, supplied: str | None) -> None:
    expected = request.session.get(CSRF_KEY)
    if (
        not isinstance(expected, str)
        or not supplied
        or not hmac.compare_digest(expected.encode(), supplied.encode())
    ):
        raise ModelDeskError(400, "invalid_request", "CSRF 校验失败")
