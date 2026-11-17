from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.auth.deps import require_access
from app.auth.service import Authenticated
from app.common.clock import SHANGHAI, billing_month, resets_at
from app.db import get_session
from app.quota.service import resolve_limit, used_tokens

router = APIRouter(prefix="/api/v1/modeldesk")


@router.get("/usage")
def usage(
    auth: Annotated[Authenticated, Depends(require_access)],
    db: Annotated[Session, Depends(get_session)],
) -> JSONResponse:
    month = billing_month()
    limit = resolve_limit(db, auth.user, model_id=0)
    used = used_tokens(db, auth.user.id, month)
    return JSONResponse(
        {
            "billing_month": month,
            "billing_timezone": SHANGHAI.key,
            "limit_tokens": limit,
            "used_tokens": used,
            "remaining_tokens": max(limit - used, 0),
            "resets_at": resets_at(month),
        },
        headers={"Cache-Control": "no-store"},
    )
