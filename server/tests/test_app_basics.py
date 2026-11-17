import pytest
from fastapi.testclient import TestClient

from app.common.errors import ModelDeskError
from app.main import create_app


@pytest.fixture()
def client():
    return TestClient(create_app(), raise_server_exceptions=False)


def test_healthz(client):
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_config_payload_is_exact(client):
    response = client.get("/api/v1/modeldesk/config")
    assert response.status_code == 200
    assert response.json() == {
        "enabled": True,
        "client_id": "modeldesk-desktop",
        "contract_version": "0.1.0",
    }


def test_every_response_carries_request_id(client):
    assert client.get("/healthz").headers["X-Request-ID"].startswith("req_")
    echoed = client.get("/healthz", headers={"X-Request-ID": "req_test_123"})
    assert echoed.headers["X-Request-ID"] == "req_test_123"
    malformed = client.get("/healthz", headers={"X-Request-ID": "bad id!"})
    assert malformed.headers["X-Request-ID"].startswith("req_")


def test_error_body_shape_and_type():
    app = create_app()

    @app.get("/boom-quota")
    def boom():
        raise ModelDeskError(
            429, "monthly_token_limit_exceeded", "本月企业模型额度已用完，请联系管理员"
        )

    response = TestClient(app).get("/boom-quota")
    assert response.status_code == 429
    body = response.json()
    assert body["error"] == {
        "message": "本月企业模型额度已用完，请联系管理员",
        "type": "quota_error",
        "code": "monthly_token_limit_exceeded",
    }
    assert body["request_id"].startswith("req_")
    assert response.headers["Cache-Control"] == "no-store"


def test_unhandled_error_is_not_leaked():
    app = create_app()

    @app.get("/boom-internal")
    def boom():
        raise RuntimeError("secret upstream detail")

    response = TestClient(app, raise_server_exceptions=False).get("/boom-internal")
    assert response.status_code == 500
    assert response.headers["X-Request-ID"] == response.json()["request_id"]
    assert response.json()["error"]["code"] == "internal_error"
    assert "secret upstream detail" not in response.text
