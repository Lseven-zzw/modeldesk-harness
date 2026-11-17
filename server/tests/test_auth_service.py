from datetime import timedelta

import pytest

from app.auth import service
from app.common.clock import utcnow
from app.common.errors import ModelDeskError
from app.models import AuthTx, SessionRow, User

VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"


def make_user(db, **kw):
    user = User(
        username=kw.get("username", "zhang.san"),
        password_hash="x",
        display_name="张三",
        department="剪辑部",
        role="EMPLOYEE",
        status=kw.get("status", 1),
        created_at=utcnow(),
    )
    db.add(user)
    db.commit()
    return user


def start(db, now, state="N8x6LXw61DPlYNVoKm5rWOj2vbJmZiRK1CPIyw50HBs"):
    created = service.create_authorization(
        db,
        origin="http://127.0.0.1:8080",
        client_id="modeldesk-desktop",
        redirect_uri="http://127.0.0.1:49152/modeldesk/callback",
        code_challenge=CHALLENGE,
        code_challenge_method="S256",
        state=state,
        device_name="金东-剪辑-01",
        client_version="1.0.0",
        now=now,
    )
    return created


def test_happy_path_issues_tokens(db):
    now = utcnow()
    user = make_user(db)
    created = start(db, now)
    grant = service.decide_authorization(
        db, auth_id=created.auth_id, user=user, decision="allow", now=now
    )
    issued = service.exchange_ticket(
        db,
        auth_id=created.auth_id,
        identity_ticket=grant.identity_ticket,
        code_verifier=VERIFIER,
        device_name="金东-剪辑-01",
        client_version="1.0.0",
        now=now,
    )
    assert issued.session.user_id == user.id
    assert issued.session.status == "ACTIVE"
    auth = service.authenticate_access(db, access_token=issued.access_token, now=now)
    assert auth.user.id == user.id
    payload = service.token_payload(issued, user, "modeldesk", "山东金东数字传媒")
    assert payload["token_type"] == "Bearer"
    assert payload["expires_in"] == 600
    assert payload["refresh_expires_in"] == 2_592_000
    assert payload["user"] == {
        "id": str(user.id),
        "username": "zhang.san",
        "display_name": "张三",
        "department": "剪辑部",
    }
    assert payload["org"] == {"id": "modeldesk", "name": "山东金东数字传媒"}


def test_ticket_is_one_time_and_burns_on_failure(db):
    now = utcnow()
    user = make_user(db)
    created = start(db, now)
    grant = service.decide_authorization(
        db, auth_id=created.auth_id, user=user, decision="allow", now=now
    )
    with pytest.raises(ModelDeskError) as wrong:
        service.exchange_ticket(
            db,
            auth_id=created.auth_id,
            identity_ticket=grant.identity_ticket,
            code_verifier="x" * 43,
            device_name=None,
            client_version=None,
            now=now,
        )
    assert wrong.value.code == "pkce_verification_failed"
    db.rollback()
    tx = db.get(AuthTx, created.auth_id)
    assert tx.status == "CONSUMED"
    with pytest.raises(ModelDeskError) as replay:
        service.exchange_ticket(
            db,
            auth_id=created.auth_id,
            identity_ticket=grant.identity_ticket,
            code_verifier=VERIFIER,
            device_name=None,
            client_version=None,
            now=now,
        )
    assert replay.value.code == "invalid_grant"


def test_deny_returns_access_denied_without_ticket(db):
    now = utcnow()
    user = make_user(db)
    created = start(db, now)
    result = service.decide_authorization(
        db, auth_id=created.auth_id, user=user, decision="deny", now=now
    )
    assert result == {
        "error": "access_denied",
        "redirect_uri": "http://127.0.0.1:49152/modeldesk/callback",
        "state": "N8x6LXw61DPlYNVoKm5rWOj2vbJmZiRK1CPIyw50HBs",
    }
    assert db.get(AuthTx, created.auth_id).status == "DENIED"


def test_refresh_rotates_and_reuse_revokes_family(db):
    now = utcnow()
    user = make_user(db)
    created = start(db, now)
    grant = service.decide_authorization(
        db, auth_id=created.auth_id, user=user, decision="allow", now=now
    )
    issued = service.exchange_ticket(
        db,
        auth_id=created.auth_id,
        identity_ticket=grant.identity_ticket,
        code_verifier=VERIFIER,
        device_name=None,
        client_version=None,
        now=now,
    )
    rotated = service.refresh_tokens(db, refresh_token=issued.refresh_token, now=now)
    assert rotated.refresh_token != issued.refresh_token
    with pytest.raises(ModelDeskError) as reused:
        service.refresh_tokens(db, refresh_token=issued.refresh_token, now=now)
    assert reused.value.code == "refresh_token_reused"
    db.rollback()
    assert db.get(SessionRow, issued.session.id).status == "REVOKED"
    with pytest.raises(ModelDeskError) as dead:
        service.authenticate_access(db, access_token=rotated.access_token, now=now)
    assert dead.value.code == "session_revoked"


def test_access_expiry_and_logout_are_distinct_errors(db):
    now = utcnow()
    user = make_user(db)
    created = start(db, now)
    grant = service.decide_authorization(
        db, auth_id=created.auth_id, user=user, decision="allow", now=now
    )
    issued = service.exchange_ticket(
        db,
        auth_id=created.auth_id,
        identity_ticket=grant.identity_ticket,
        code_verifier=VERIFIER,
        device_name=None,
        client_version=None,
        now=now,
    )
    with pytest.raises(ModelDeskError) as expired:
        service.authenticate_access(
            db,
            access_token=issued.access_token,
            now=now.replace(year=now.year, month=now.month, day=now.day) + timedelta(seconds=601),
        )
    assert expired.value.code == "session_expired"
    service.logout(db, access_token=issued.access_token, refresh_token=None, now=now)
    service.logout(db, access_token=issued.access_token, refresh_token=None, now=now)  # 幂等
    with pytest.raises(ModelDeskError) as revoked:
        service.authenticate_access(db, access_token=issued.access_token, now=now)
    assert revoked.value.code == "session_revoked"


def test_disabled_user_is_rejected(db):
    now = utcnow()
    user = make_user(db)
    created = start(db, now)
    grant = service.decide_authorization(
        db, auth_id=created.auth_id, user=user, decision="allow", now=now
    )
    issued = service.exchange_ticket(
        db,
        auth_id=created.auth_id,
        identity_ticket=grant.identity_ticket,
        code_verifier=VERIFIER,
        device_name=None,
        client_version=None,
        now=now,
    )
    user.status = 0
    db.commit()
    with pytest.raises(ModelDeskError) as blocked:
        service.authenticate_access(db, access_token=issued.access_token, now=now)
    assert blocked.value.code == "user_disabled"


@pytest.mark.parametrize(
    "redirect",
    [
        "http://127.0.0.1:bad/modeldesk/callback",
        "http://user@127.0.0.1:49152/modeldesk/callback",
        "http://127.0.0.1:49152/modeldesk/callback?code=old",
    ],
)
def test_invalid_loopback_redirect(db, redirect):
    with pytest.raises(ModelDeskError) as rejected:
        service.create_authorization(
            db,
            origin="http://127.0.0.1:8080",
            client_id="modeldesk-desktop",
            redirect_uri=redirect,
            code_challenge=CHALLENGE,
            code_challenge_method="S256",
            state="state",
            device_name=None,
            client_version=None,
            now=utcnow(),
        )
    assert rejected.value.code == "invalid_request"


def test_refresh_preserves_absolute_expiry(db):
    now = utcnow()
    user = make_user(db)
    created = start(db, now)
    grant = service.decide_authorization(
        db, auth_id=created.auth_id, user=user, decision="allow", now=now
    )
    issued = service.exchange_ticket(
        db,
        auth_id=created.auth_id,
        identity_ticket=grant.identity_ticket,
        code_verifier=VERIFIER,
        device_name=None,
        client_version=None,
        now=now,
    )
    cutoff = issued.session.absolute_expires_at
    rotated = service.refresh_tokens(
        db,
        refresh_token=issued.refresh_token,
        now=cutoff - timedelta(seconds=30),
    )
    assert rotated.session.id == issued.session.id
    assert rotated.session.absolute_expires_at == cutoff
    assert rotated.access_expires_at == rotated.refresh_expires_at == cutoff
    assert service.token_payload(rotated, user, "modeldesk", "ModelDesk")["expires_in"] == 30
