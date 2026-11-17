from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth import service
from app.common.clock import utcnow
from app.common.errors import ModelDeskError
from app.db import get_session
from app.settings import get_settings

router = APIRouter(prefix="/api/v1/modeldesk")


class AuthorizationCreate(BaseModel):
    client_id: str
    redirect_uri: str
    code_challenge: str
    code_challenge_method: str
    state: str
    device_name: str | None = Field(default=None, max_length=100)
    client_version: str | None = Field(default=None, max_length=64)


class TokenRequest(BaseModel):
    grant_type: str
    identity_ticket: str | None = None
    auth_id: str | None = None
    code_verifier: str | None = None
    refresh_token: str | None = None


@router.post("/authorizations")
def create_authorization(
    body: AuthorizationCreate, db: Annotated[Session, Depends(get_session)]
) -> dict:
    origin = get_settings().base_url.rstrip("/")
    created = service.create_authorization(
        db,
        origin=origin,
        client_id=body.client_id,
        redirect_uri=body.redirect_uri,
        code_challenge=body.code_challenge,
        code_challenge_method=body.code_challenge_method,
        state=body.state,
        device_name=body.device_name,
        client_version=body.client_version,
        now=utcnow(),
    )
    return {
        "auth_id": created.auth_id,
        "authorize_url": created.authorize_url,
        "expires_in": created.expires_in,
    }


@router.post("/token")
def token(body: TokenRequest, db: Annotated[Session, Depends(get_session)]) -> JSONResponse:
    now = utcnow()
    settings = get_settings()
    if body.grant_type == "identity_ticket":
        if not (body.identity_ticket and body.auth_id and body.code_verifier):
            raise ModelDeskError(400, "invalid_request", "换证参数不完整")
        issued = service.exchange_ticket(
            db,
            auth_id=body.auth_id,
            identity_ticket=body.identity_ticket,
            code_verifier=body.code_verifier,
            device_name=None,
            client_version=None,
            now=now,
        )
    elif body.grant_type == "refresh_token":
        if not body.refresh_token:
            raise ModelDeskError(400, "invalid_request", "缺少 refresh_token")
        issued = service.refresh_tokens(db, refresh_token=body.refresh_token, now=now)
    else:
        raise ModelDeskError(400, "invalid_request", "grant_type 不受支持")
    payload = service.token_payload(issued, issued.user, settings.org_id, settings.org_name)
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


class LogoutRequest(BaseModel):
    refresh_token: str | None = None


@router.post("/logout", status_code=204)
def logout(
    request: Request,
    db: Annotated[Session, Depends(get_session)],
    body: LogoutRequest | None = None,
) -> Response:
    header = request.headers.get("authorization", "")
    access = header[7:] if header.lower().startswith("bearer ") else None
    refresh = body.refresh_token if body else None
    service.logout(db, access_token=access, refresh_token=refresh, now=utcnow())
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/config")
def config() -> dict:
    settings = get_settings()
    if not settings.enabled:
        return {"enabled": False}
    return {
        "enabled": True,
        "client_id": "modeldesk-desktop",
        "contract_version": settings.contract_version,
    }
