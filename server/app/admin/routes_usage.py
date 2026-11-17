import re
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from app.admin.rbac import Access, department_filter
from app.auth.admin_session import require_permission
from app.common.clock import billing_month
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import ModelCall, MonthlyUsage, User
from app.quota.service import resolve_limits


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(_no_store)])


def _month(value: str | None) -> str:
    if value is None:
        return billing_month()
    if not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", value) or value.startswith("0000"):
        raise ModelDeskError(400, "invalid_request", "月份必须为 YYYY-MM")
    return value


@router.get("/usage/calls")
def usage_calls(
    access: Annotated[Access, Depends(require_permission("usage.read"))],
    db: Annotated[Session, Depends(get_session)],
    month: str | None = None,
    user_id: int | None = None,
    model_id: int | None = None,
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
) -> dict:
    month = _month(month)
    page = max(page, 1)
    page_size = min(max(page_size, 1), 200)
    stmt = select(ModelCall).where(ModelCall.billing_month == month)
    if access.departments is not None:
        stmt = stmt.where(
            ModelCall.user_id.in_(select(User.id).where(department_filter(db, access.departments)))
        )
    if any(value is not None and not 0 < value <= 2**63 - 1 for value in (user_id, model_id)):
        raise ModelDeskError(400, "invalid_request", "员工或模型 ID 无效")
    if user_id is not None:
        stmt = stmt.where(ModelCall.user_id == user_id)
    if model_id is not None:
        stmt = stmt.where(ModelCall.model_id == model_id)
    if status:
        stmt = stmt.where(ModelCall.status == status)
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    offset = (page - 1) * page_size
    rows = (
        db.scalars(
            stmt.order_by(ModelCall.created_at.desc(), ModelCall.id.desc())
            .offset(offset)
            .limit(page_size)
        ).all()
        if offset < total
        else []
    )
    names = (
        {
            user.id: user.display_name
            for user in db.scalars(select(User).where(User.id.in_({row.user_id for row in rows})))
        }
        if rows
        else {}
    )
    return {
        "month": month,
        "total": total,
        "items": [
            {
                "id": row.id,
                "request_id": row.request_id,
                "user_id": row.user_id,
                "display_name": names.get(row.user_id),
                "model_id": row.model_id,
                "model_code": row.model_code,
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "total_tokens": row.total_tokens,
                "status": row.status,
                "http_status": row.http_status,
                "latency_ms": row.latency_ms,
                "created_at": row.created_at.isoformat(),
            }
            for row in rows
        ],
    }


@router.get("/usage/summary")
def usage_summary(
    access: Annotated[Access, Depends(require_permission("usage.read"))],
    db: Annotated[Session, Depends(get_session)],
    month: str | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict:
    month = _month(month)
    unknown = case((
        and_(ModelCall.total_tokens.is_(None),
             ModelCall.status.not_in(("INVALID_REQUEST", "MODEL_NOT_ALLOWED", "BLOCKED_QUOTA"))),
        1,
    ), else_=0)
    statement = (
        select(
            ModelCall.user_id,
            func.count(ModelCall.id).label("calls"),
            func.sum(ModelCall.total_tokens).label("tokens"),
            func.sum(unknown).label("unknown"),
        )
        .where(ModelCall.billing_month == month)
        .group_by(ModelCall.user_id)
    )
    if access.departments is not None:
        statement = statement.where(
            ModelCall.user_id.in_(select(User.id).where(department_filter(db, access.departments)))
        )
    activity = statement.subquery()
    used = func.coalesce(MonthlyUsage.used_tokens, 0).label("used")
    rollup = (
        select(User.id.label("user_id"), activity.c.calls, activity.c.tokens, activity.c.unknown, used)
        .join(activity, activity.c.user_id == User.id)
        .outerjoin(MonthlyUsage, and_(MonthlyUsage.user_id == User.id, MonthlyUsage.billing_month == month))
        .subquery()
    )
    people, total_used, total_unknown = db.execute(
        select(func.count(), func.sum(rollup.c.used), func.sum(rollup.c.unknown)).select_from(rollup)
    ).one()
    offset = (page - 1) * page_size
    rows = db.execute(
        select(User, rollup.c.calls, rollup.c.tokens, rollup.c.unknown, rollup.c.used)
        .join(rollup, rollup.c.user_id == User.id)
        .order_by(rollup.c.used.desc(), User.id)
        .offset(offset).limit(page_size)
    ).all() if offset < people else []
    limits = resolve_limits(db, [row[0] for row in rows], model_id=0)
    return {
        "month": month,
        "totals": {"people": people, "used": int(total_used or 0), "unknown": int(total_unknown or 0)},
        "items": [
            {
                "user_id": user.id,
                "display_name": user.display_name,
                "department": user.department,
                "limit_tokens": limits[user.id],
                "used_tokens": int(used_tokens),
                "call_count": calls,
                "unknown_usage_calls": int(unknown_calls),
                "tokens_in_window": None if tokens is None else int(tokens),
            }
            for user, calls, tokens, unknown_calls, used_tokens in rows
        ],
    }


@router.get("/usage/employees")
def usage_employees(
    access: Annotated[Access, Depends(require_permission("usage.read"))],
    db: Annotated[Session, Depends(get_session)],
    month: str | None = None,
    q: Annotated[str, Query(max_length=100)] = "",
) -> dict:
    month = _month(month)
    active_user = select(ModelCall.id).where(
        ModelCall.user_id == User.id, ModelCall.billing_month == month,
    ).exists()
    statement = select(User.id, User.display_name).where(active_user)
    if access.departments is not None:
        statement = statement.where(department_filter(db, access.departments))
    if term := q.strip():
        statement = statement.where(or_(
            User.display_name.icontains(term, autoescape=True),
            User.username.icontains(term, autoescape=True),
        ))
    rows = db.execute(statement.order_by(User.display_name, User.id).limit(50))
    return {"items": [{"user_id": user_id, "display_name": name} for user_id, name in rows]}
