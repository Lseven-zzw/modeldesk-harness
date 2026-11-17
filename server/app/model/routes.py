from datetime import UTC
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.auth.deps import require_access
from app.auth.service import Authenticated
from app.db import get_session
from app.model.visibility import visible_models
from app.models import ModelRow

router = APIRouter(prefix="/api/v1/modeldesk")
CAPABILITY_KEYS = ("streaming", "tools", "reasoning_content")


def _catalog_entry(row: ModelRow) -> dict:
    parts = [part.strip() for part in row.capabilities.split(",")]
    window = 32768
    for part in parts:
        if part.startswith("ctx:"):
            raw = part.removeprefix("ctx:")
            if raw.isascii() and raw.isdecimal() and int(raw) > 0:
                window = int(raw)
                break
    return {
        "id": f"modeldesk:{row.id}",
        "object": "model",
        "created": int(row.created_at.replace(tzinfo=UTC).timestamp()),
        "owned_by": "modeldesk",
        "display_name": row.display_name,
        "context_window": window,
        "capabilities": {key: key in parts for key in CAPABILITY_KEYS},
    }


@router.get("/models")
def list_models(
    auth: Annotated[Authenticated, Depends(require_access)],
    db: Annotated[Session, Depends(get_session)],
) -> JSONResponse:
    data = [_catalog_entry(row) for row in visible_models(db, auth.user)]
    return JSONResponse({"object": "list", "data": data}, headers={"Cache-Control": "no-store"})
