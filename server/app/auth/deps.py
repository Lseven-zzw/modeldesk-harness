from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.auth.service import Authenticated, authenticate_access
from app.common.clock import utcnow
from app.common.errors import ModelDeskError
from app.db import get_session


def require_access(
    request: Request, db: Annotated[Session, Depends(get_session, scope="function")]
) -> Authenticated:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise ModelDeskError(401, "invalid_access_token", "缺少访问令牌")
    return authenticate_access(db, access_token=header[7:].strip(), now=utcnow())
