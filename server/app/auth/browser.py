import re
from typing import Annotated, Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Form, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.admin.rbac import can_access_admin
from app.auth import service
from app.auth.admin_session import (
    browser_user,
    check_csrf,
    clear_admin_session,
    csrf_token,
    require_admin_portal,
    require_browser_user,
    require_csrf,
    start_admin_session,
)
from app.auth.pages import render_desktop_launch_page, render_desktop_login_page, render_login_page
from app.common.clock import utcnow
from app.common.passwords import verify_password
from app.db import get_session
from app.models import AuthTx, User

router = APIRouter()
NO_STORE = {"Cache-Control": "no-store"}
_DESKTOP_NEXT = re.compile(r"/desktop-login\?auth_id=gtx_[0-9a-f]{32}")


def _next_url(target: str) -> str:
    return target if _DESKTOP_NEXT.fullmatch(target) else "/admin/"


@router.get("/admin/login", response_class=HTMLResponse)
def login_form(request: Request, next: str = "/admin") -> HTMLResponse:
    return render_login_page(_next_url(next), csrf_token(request))


@router.post("/admin/login")
def login_submit(
    request: Request,
    username: Annotated[str, Form()],
    password: Annotated[str, Form()],
    csrf: Annotated[str, Form()],
    db: Annotated[Session, Depends(get_session)],
    next: Annotated[str, Form()] = "/admin",
):
    check_csrf(request, csrf)
    target = _next_url(next)
    user = db.scalar(select(User).where(User.username == username))
    if (
        user is None
        or user.status != 1
        or not verify_password(user.password_hash, password)
        or (target == "/admin/" and not can_access_admin(db, user))
    ):
        return render_login_page(target, csrf_token(request), "账号或密码无效")
    start_admin_session(request, user)
    return RedirectResponse(target, status_code=302, headers=NO_STORE)


@router.post("/admin/logout")
def admin_logout(
    request: Request,
    _user: Annotated[User, Depends(require_browser_user)],
    _csrf: Annotated[None, Depends(require_csrf)],
):
    clear_admin_session(request)
    return RedirectResponse("/admin/login", status_code=302, headers=NO_STORE)


@router.get("/api/admin/csrf")
def admin_csrf(request: Request, _admin: Annotated[User, Depends(require_admin_portal)]) -> JSONResponse:
    return JSONResponse({"csrf": csrf_token(request)}, headers=NO_STORE)


@router.get("/desktop-login", response_class=HTMLResponse)
def desktop_login(request: Request, db: Annotated[Session, Depends(get_session)], auth_id: str | None = None):
    if auth_id is None:
        return render_desktop_launch_page(str(request.base_url).rstrip("/"))
    tx = db.get(AuthTx, auth_id)
    if tx is None or tx.status != "PENDING" or tx.expires_at <= utcnow():
        return HTMLResponse("<p>授权链接已失效，请回到桌面客户端重新发起登录。</p>", 410, NO_STORE)
    if browser_user(request, db) is None:
        target = f"/desktop-login?{urlencode({'auth_id': auth_id})}"
        return RedirectResponse(f"/admin/login?{urlencode({'next': target})}", 302, NO_STORE)
    return render_desktop_login_page(tx, csrf_token(request))


class AuthorizeRequest(BaseModel):
    auth_id: str
    decision: Literal["allow", "deny"]


@router.post("/api/v1/modeldesk/authorize")
def authorize(
    body: AuthorizeRequest,
    user: Annotated[User, Depends(require_browser_user)],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> JSONResponse:
    result = service.decide_authorization(
        db, auth_id=body.auth_id, user=user, decision=body.decision, now=utcnow()
    )
    payload = (
        result
        if isinstance(result, dict)
        else {
            "identity_ticket": result.identity_ticket,
            "redirect_uri": result.redirect_uri,
            "state": result.state,
            "expires_in": result.expires_in,
        }
    )
    return JSONResponse(payload, headers=NO_STORE)
