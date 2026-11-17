import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from urllib.parse import urlencode, urlsplit

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.common.errors import ModelDeskError
from app.common.ids import new_id, new_token, pkce_s256, sha256_hex
from app.models import AuthTx, RefreshToken, SessionRow, User
from app.settings import get_settings

VERIFIER = re.compile(r"[A-Za-z0-9._~-]{43,128}")
CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
STATE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
LOOPBACK_PATH = "/modeldesk/callback"
CLIENT_ID = "modeldesk-desktop"


@dataclass(frozen=True)
class AuthorizationCreated:
    auth_id: str
    authorize_url: str
    expires_in: int


@dataclass(frozen=True)
class IdentityGrant:
    identity_ticket: str
    redirect_uri: str
    state: str
    expires_in: int


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str
    access_expires_at: datetime
    refresh_expires_at: datetime
    session: SessionRow
    issued_at: datetime
    user: User


@dataclass(frozen=True)
class Authenticated:
    user: User
    session: SessionRow


def _invalid(message: str, code: str = "invalid_request") -> ModelDeskError:
    return ModelDeskError(400, code, message)


def _validate_redirect(uri: str) -> None:
    try:
        parts = urlsplit(uri)
        port = parts.port
    except ValueError as exc:
        raise _invalid("redirect_uri 非法") from exc
    if not port or parts.netloc != f"127.0.0.1:{port}" or "?" in uri or "#" in uri:
        raise _invalid("redirect_uri 非法")
    if parts.scheme != "http" or parts.hostname != "127.0.0.1" or parts.path != LOOPBACK_PATH:
        raise _invalid("redirect_uri 必须是 http://127.0.0.1:<port>/modeldesk/callback")


def create_authorization(
    db: Session,
    *,
    origin: str,
    client_id: str,
    redirect_uri: str,
    code_challenge: str,
    code_challenge_method: str,
    state: str,
    device_name: str | None,
    client_version: str | None,
    now: datetime,
) -> AuthorizationCreated:
    settings = get_settings()
    if client_id != CLIENT_ID:
        raise _invalid("client_id 不受支持")
    _validate_redirect(redirect_uri)
    if not CHALLENGE.fullmatch(code_challenge) or code_challenge_method != "S256":
        raise _invalid("仅支持 S256 PKCE（code_challenge 43 字符）")
    if not STATE.fullmatch(state):
        raise _invalid("state 非法")
    auth_id = new_id("gtx")
    db.add(
        AuthTx(
            id=auth_id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            code_challenge=code_challenge,
            code_challenge_method="S256",
            state=state,
            device_name=device_name,
            client_version=client_version,
            status="PENDING",
            expires_at=now + timedelta(seconds=settings.auth_tx_ttl_seconds),
            created_at=now,
        )
    )
    db.commit()
    query = urlencode({"auth_id": auth_id})
    return AuthorizationCreated(
        auth_id, f"{origin}{'/desktop-login'}?{query}", settings.auth_tx_ttl_seconds
    )


def _auth_transaction(db: Session, auth_id: str) -> AuthTx | None:
    return db.get(AuthTx, auth_id, with_for_update=True, populate_existing=True)


def _active_user(db: Session, user_id: int | None) -> User:
    user = db.get(User, user_id, populate_existing=True) if user_id is not None else None
    if user is None or user.status != 1:
        raise ModelDeskError(403, "user_disabled", "账号已停用，请联系管理员")
    return user


def decide_authorization(
    db: Session, *, auth_id: str, user: User, decision: str, now: datetime
) -> IdentityGrant | dict:
    if decision not in {"allow", "deny"}:
        raise _invalid("授权决定非法")
    tx = _auth_transaction(db, auth_id)
    if tx is None or tx.status != "PENDING" or tx.expires_at <= now:
        raise _invalid("授权事务不存在或已失效")
    if decision == "deny":
        result = {"error": "access_denied", "redirect_uri": tx.redirect_uri, "state": tx.state}
        tx.status = "DENIED"
        db.commit()
        return result

    _active_user(db, user.id)
    ticket = new_token()
    tx.ticket_hash = sha256_hex(ticket)
    tx.ticket_expires_at = min(
        now + timedelta(seconds=get_settings().ticket_ttl_seconds), tx.expires_at
    )
    tx.user_id = user.id
    tx.status = "AUTHORIZED"
    grant = IdentityGrant(
        ticket, tx.redirect_uri, tx.state, int((tx.ticket_expires_at - now).total_seconds())
    )
    db.commit()
    return grant


def _issue(
    db: Session, session: SessionRow, now: datetime, user: User
) -> tuple[IssuedTokens, RefreshToken]:
    settings = get_settings()
    access, refresh = new_token(), new_token()
    access_expires_at = min(
        now + timedelta(seconds=settings.access_ttl_seconds), session.absolute_expires_at
    )
    refresh_expires_at = min(
        now + timedelta(seconds=settings.refresh_ttl_seconds), session.absolute_expires_at
    )
    session.access_hash = sha256_hex(access)
    session.access_expires_at = access_expires_at
    refresh_row = RefreshToken(
        id=new_id("grt"),
        session_id=session.id,
        token_hash=sha256_hex(refresh),
        expires_at=refresh_expires_at,
        created_at=now,
    )
    db.add_all([session, refresh_row])
    return IssuedTokens(
        access, refresh, access_expires_at, refresh_expires_at, session, now, user
    ), refresh_row


def exchange_ticket(
    db: Session,
    *,
    auth_id: str,
    identity_ticket: str,
    code_verifier: str,
    device_name: str | None,
    client_version: str | None,
    now: datetime,
) -> IssuedTokens:
    tx = _auth_transaction(db, auth_id)
    if tx is None or tx.status != "AUTHORIZED":
        raise _invalid("票据不存在或已使用", "invalid_grant")

    tx.status = "CONSUMED"
    try:
        if tx.expires_at <= now or tx.ticket_expires_at is None or tx.ticket_expires_at <= now:
            raise _invalid("票据已过期", "invalid_grant")
        if not secrets.compare_digest(tx.ticket_hash or "", sha256_hex(identity_ticket)):
            raise _invalid("票据不匹配", "invalid_grant")
        if not VERIFIER.fullmatch(code_verifier) or not secrets.compare_digest(
            pkce_s256(code_verifier), tx.code_challenge
        ):
            raise _invalid("PKCE 校验失败", "pkce_verification_failed")
        user = _active_user(db, tx.user_id)
    except ModelDeskError:
        db.commit()
        raise

    session = SessionRow(
        id=new_id("gsess"),
        user_id=user.id,
        device_name=tx.device_name,
        client_version=tx.client_version,
        refresh_family_id=new_id("grt"),
        absolute_expires_at=now + timedelta(seconds=get_settings().session_ttl_seconds),
        status="ACTIVE",
        created_at=now,
    )
    issued, _ = _issue(db, session, now, user)
    db.commit()
    return issued


def _session_by_access(db: Session, token: str) -> SessionRow | None:
    return db.scalar(
        select(SessionRow)
        .where(SessionRow.access_hash == sha256_hex(token))
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _refresh_lookup(db: Session, token: str):
    return db.execute(
        select(RefreshToken.id, RefreshToken.session_id).where(
            RefreshToken.token_hash == sha256_hex(token)
        )
    ).one_or_none()


def _lock_session(db: Session, session_id: str) -> SessionRow | None:
    return db.get(SessionRow, session_id, with_for_update=True, populate_existing=True)


def _revoke_family(db: Session, session: SessionRow, now: datetime) -> None:
    session.status = "REVOKED"
    db.execute(
        update(RefreshToken)
        .where(RefreshToken.session_id == session.id, RefreshToken.used_at.is_(None))
        .values(used_at=now)
    )


def refresh_tokens(db: Session, *, refresh_token: str, now: datetime) -> IssuedTokens:
    lookup = _refresh_lookup(db, refresh_token)
    if lookup is None:
        raise ModelDeskError(401, "invalid_refresh_token", "刷新令牌无效")
    # Refresh and logout both lock the session before changing refresh rows.
    session = _lock_session(db, lookup.session_id)
    if session is None:
        raise ModelDeskError(401, "session_revoked", "会话已撤销")
    row = db.get(RefreshToken, lookup.id, with_for_update=True, populate_existing=True)
    if row is None:
        raise ModelDeskError(401, "invalid_refresh_token", "刷新令牌无效")
    if row.used_at is not None:
        _revoke_family(db, session, now)
        db.commit()
        raise ModelDeskError(401, "refresh_token_reused", "检测到刷新令牌重放，已撤销该设备会话")
    if session.status == "REVOKED":
        raise ModelDeskError(401, "session_revoked", "会话已撤销")
    if session.status != "ACTIVE" or session.absolute_expires_at <= now:
        session.status = "EXPIRED"
        db.commit()
        raise ModelDeskError(401, "session_expired", "会话已到期，请重新登录")
    if row.expires_at <= now:
        raise ModelDeskError(401, "invalid_refresh_token", "刷新令牌已过期")

    user = _active_user(db, session.user_id)
    issued, replacement = _issue(db, session, now, user)
    row.used_at = now
    row.replaced_by = replacement.id
    db.commit()
    return issued


def authenticate_access(db: Session, *, access_token: str, now: datetime) -> Authenticated:
    session = _session_by_access(db, access_token)
    if session is None:
        raise ModelDeskError(401, "invalid_access_token", "访问令牌无效")
    if session.status == "REVOKED":
        raise ModelDeskError(401, "session_revoked", "会话已撤销")
    if (
        session.status != "ACTIVE"
        or min(session.access_expires_at, session.absolute_expires_at) <= now
    ):
        raise ModelDeskError(401, "session_expired", "会话已过期，请重新登录")
    user = _active_user(db, session.user_id)
    if session.last_seen_at is None or now - session.last_seen_at >= timedelta(seconds=60):
        session.last_seen_at = now
    db.commit()
    return Authenticated(user, session)


def logout(
    db: Session, *, access_token: str | None, refresh_token: str | None, now: datetime
) -> None:
    session = _session_by_access(db, access_token) if access_token else None
    if session is None and refresh_token:
        lookup = _refresh_lookup(db, refresh_token)
        session = _lock_session(db, lookup.session_id) if lookup else None
    if session is not None:
        _revoke_family(db, session, now)
    db.commit()


def token_payload(issued: IssuedTokens, user: User, org_id: str, org_name: str) -> dict:
    return {
        "token_type": "Bearer",
        "access_token": issued.access_token,
        "expires_in": int((issued.access_expires_at - issued.issued_at).total_seconds()),
        "refresh_token": issued.refresh_token,
        "refresh_expires_in": int((issued.refresh_expires_at - issued.issued_at).total_seconds()),
        "session_id": issued.session.id,
        "session_expires_at": issued.session.absolute_expires_at.isoformat() + "Z",
        "user": {
            "id": str(user.id),
            "username": user.username,
            "display_name": user.display_name,
            "department": user.department,
        },
        "org": {"id": org_id, "name": org_name},
    }
