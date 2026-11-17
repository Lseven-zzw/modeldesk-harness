import json

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.auth import service
from app.common.clock import billing_month, utcnow
from app.common.crypto import SecretBox
from app.common.ids import pkce_s256
from app.common.passwords import hash_password
from app.main import create_app
from app.models import ModelCall, ModelChannel, ModelGrant, ModelRow, MonthlyUsage, User
from app.settings import get_settings

VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"


def seed(db):
    box = SecretBox(get_settings().master_key)
    user = User(
        username="zhang.san",
        password_hash=hash_password("p"),
        display_name="张三",
        department="剪辑部",
        role="EMPLOYEE",
        status=1,
        created_at=utcnow(),
    )
    db.add(user)
    db.commit()
    model = ModelRow(
        code="deepseek-chat",
        display_name="DeepSeek / deepseek-chat",
        provider_name="DeepSeek",
        upstream_kind="openai",
        upstream_model="deepseek-chat",
        upstream_base="https://api.example.com/v1",
        api_key_cipher=box.encrypt("sk-upstream"),
        extra_config=None,
        capabilities="streaming,tools",
        enabled=1,
        created_at=utcnow(),
    )
    db.add(model)
    db.commit()
    db.add(
        ModelGrant(model_id=model.id, subject_type="EVERYONE", subject_id="*", created_at=utcnow())
    )
    db.commit()
    return user, model


def login(db, user):
    now = utcnow()
    tx = service.create_authorization(
        db,
        origin="http://127.0.0.1:8080",
        client_id="modeldesk-desktop",
        redirect_uri="http://127.0.0.1:49152/modeldesk/callback",
        code_challenge=pkce_s256(VERIFIER),
        code_challenge_method="S256",
        state="state-1",
        device_name=None,
        client_version=None,
        now=now,
    )
    grant = service.decide_authorization(
        db, auth_id=tx.auth_id, user=user, decision="allow", now=now
    )
    return service.exchange_ticket(
        db,
        auth_id=tx.auth_id,
        identity_ticket=grant.identity_ticket,
        code_verifier=VERIFIER,
        device_name=None,
        client_version=None,
        now=now,
    ).access_token


SSE = (
    b'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"\\u4f60\\u597d"}}]}\n\n'
    b'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
    b'data: {"id":"c1","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n'
    b"data: [DONE]\n\n"
)


@pytest.fixture()
def env(db, request):
    user, model = seed(db)
    calls = []
    stream = getattr(request, "param", SSE)

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"},
            content=stream,
        )

    from app.db import get_session

    app = create_app(
        upstream_transport=httpx.MockTransport(handler),
        session_factory=sessionmaker(bind=db.get_bind()),
    )
    app.dependency_overrides[get_session] = lambda: db
    token = login(db, user)
    with TestClient(app) as client:
        yield client, token, model, calls


def test_proxy_uses_current_channel_configuration(env, db):
    client, token, model, calls = env
    box = SecretBox(get_settings().master_key)
    channel = ModelChannel(
        name="团队渠道", upstream_kind="openai", upstream_base="https://channel.example/v1",
        api_key_cipher=box.encrypt("sk-channel-first"), key_hint="irst",
    )
    model.channel = channel
    db.commit()
    for secret in ("sk-channel-first", "sk-channel-rotated"):
        channel.api_key_cipher = box.encrypt(secret)
        db.commit()
        response = client.post(
            "/api/v1/modeldesk/chat/completions", headers={"Authorization": f"Bearer {token}"},
            json={"model": f"modeldesk:{model.id}", "stream": True, "messages": [{"role": "user", "content": "你好"}]},
        )
        assert response.status_code == 200
        assert str(calls[-1].url) == "https://channel.example/v1/chat/completions"
        assert calls[-1].headers["Authorization"] == f"Bearer {secret}"
        assert json.loads(calls[-1].content)["model"] == model.upstream_model


def test_stream_is_forwarded_and_settled(env, db):
    client, token, model, calls = env
    response = client.post(
        "/api/v1/modeldesk/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "model": f"modeldesk:{model.id}",
            "stream": True,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": "你好"}],
        },
    )
    assert response.status_code == 200
    assert response.text == SSE.decode()
    assert response.headers["Cache-Control"] == "no-store"
    assert calls[0].headers["Authorization"] == "Bearer sk-upstream"
    sent = json.loads(calls[0].content)
    assert sent["stream"] is True and sent["stream_options"] == {"include_usage": True}
    assert sent["model"] == "deepseek-chat"

    record = db.query(ModelCall).one()
    assert (record.status, record.input_tokens, record.output_tokens, record.total_tokens) == (
        "SUCCESS",
        12,
        5,
        17,
    )
    usage = db.get(MonthlyUsage, {"user_id": record.user_id, "billing_month": billing_month()})
    assert usage.used_tokens == 17


@pytest.mark.parametrize("env", [
    SSE.split(b"data: [DONE]")[0],
    b"\n\n".join(frame for frame in SSE.split(b"\n\n") if b"finish_reason" not in frame),
], indirect=True)
def test_truncated_stream_records_status_and_known_usage(env, db):
    client, token, model, _ = env
    response = client.post(
        "/api/v1/modeldesk/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={"model": f"modeldesk:{model.id}", "stream": True,
              "messages": [{"role": "user", "content": "hi"}]},
    )
    assert '"code": "upstream_incomplete"' in response.text
    record = db.query(ModelCall).one()
    assert (record.status, record.total_tokens) == ("UPSTREAM_INCOMPLETE", 17)
    assert db.query(MonthlyUsage).one().used_tokens == 17


def test_blocked_quota_does_not_call_upstream(env, db):
    client, token, model, calls = env
    user = db.query(User).filter(User.username == "zhang.san").one()
    db.add(
        MonthlyUsage(
            user_id=user.id,
            billing_month=billing_month(),
            used_tokens=get_settings().default_monthly_tokens,
            updated_at=utcnow(),
        )
    )
    db.commit()
    response = client.post(
        "/api/v1/modeldesk/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "model": f"modeldesk:{model.id}",
            "stream": True,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": "你好"}],
        },
    )
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "monthly_token_limit_exceeded"
    assert calls == []
    record = db.query(ModelCall).one()
    assert record.status == "BLOCKED_QUOTA" and record.total_tokens is None


def test_denied_model_is_audited_without_charging_usage(env, db):
    client, token, model, calls = env
    db.query(ModelGrant).filter_by(model_id=model.id).delete()
    db.commit()
    response = client.post(
        "/api/v1/modeldesk/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={"model": f"modeldesk:{model.id}", "messages": [{"role": "user", "content": "你好"}]},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "model_not_allowed"
    assert calls == []
    record = db.query(ModelCall).filter_by(request_id=response.headers["X-Request-ID"]).one()
    assert (record.status, record.http_status, record.total_tokens) == ("MODEL_NOT_ALLOWED", 403, None)
    assert db.query(MonthlyUsage).count() == 0


def test_unsupported_parameter_is_rejected(env):
    client, token, model, _ = env
    response = client.post(
        "/api/v1/modeldesk/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "model": f"modeldesk:{model.id}",
            "stream": True,
            "stream_options": {"include_usage": True},
            "logprobs": True,
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unsupported_parameter"


def test_upstream_auth_failure_maps_to_502_without_leaking(env, db):
    _client, token, model, _ = env
    from app.db import get_session

    app = create_app(
        upstream_transport=httpx.MockTransport(
            lambda request: httpx.Response(401, json={"error": "Invalid API key sk-upstream"})
        ),
        session_factory=sessionmaker(bind=db.get_bind()),
    )
    app.dependency_overrides[get_session] = lambda: db
    with TestClient(app) as rejected:
        response = rejected.post(
            "/api/v1/modeldesk/chat/completions",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "model": f"modeldesk:{model.id}",
                "stream": True,
                "stream_options": {"include_usage": True},
                "messages": [{"role": "user", "content": "hi"}],
            },
        )
    assert response.status_code == 502
    assert "sk-upstream" not in response.text
    record = db.query(ModelCall).order_by(ModelCall.id.desc()).first()
    assert record.status == "UPSTREAM_ERROR" and record.total_tokens is None


def test_usage_is_metered_even_when_hidden_from_stream(env, db):
    client, token, model, _ = env
    response = client.post(
        "/api/v1/modeldesk/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "model": f"modeldesk:{model.id}",
            "stream": True,
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert response.status_code == 200
    assert '"usage"' not in response.text
    assert response.text.endswith("data: [DONE]\n\n")
    assert db.query(ModelCall).one().total_tokens == 17


def test_nonstream_collects_upstream_sse(env):
    client, token, model, calls = env
    response = client.post(
        "/api/v1/modeldesk/chat/completions",
        headers={"Authorization": f"Bearer {token}"},
        json={"model": f"modeldesk:{model.id}", "messages": [{"role": "user", "content": "hi"}]},
    )
    assert response.status_code == 200
    result = response.json()
    assert result["choices"][0]["message"]["content"] == "你好"
    assert result["usage"]["completion_tokens"] == 5
    assert json.loads(calls[0].content)["stream"] is True


def test_settle_is_idempotent(db):
    from app.proxy.settle import settle_call

    user, model = seed(db)
    now = utcnow()
    params = {
        "request_id": "req_repeat",
        "user_id": user.id,
        "session_id": "gsess_test",
        "model_id": model.id,
        "model_code": model.code,
        "month": billing_month(now),
        "status": "SUCCESS",
        "http_status": 200,
        "latency_ms": 15,
        "input_tokens": 12,
        "output_tokens": 5,
        "cached_tokens": None,
        "now": now,
        "session_factory": sessionmaker(bind=db.get_bind()),
    }
    settle_call(**params)
    settle_call(**params)
    assert db.query(ModelCall).count() == 1
    assert db.query(MonthlyUsage).one().used_tokens == 17
