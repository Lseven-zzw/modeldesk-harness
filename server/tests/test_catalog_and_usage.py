from tests.test_proxy import env

__all__ = ["env"]


def test_models_lists_only_granted(env, db):
    client, token, model, _ = env
    model.capabilities += ",ctx:131072"
    db.commit()
    response = client.get("/api/v1/modeldesk/models", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    data = response.json()["data"]
    assert [item["id"] for item in data] == [f"modeldesk:{model.id}"]
    assert data[0]["context_window"] == 131072
    assert response.headers["Cache-Control"] == "no-store"
    assert data[0]["owned_by"] == "modeldesk"
    assert data[0]["display_name"] == "DeepSeek / deepseek-chat"
    assert data[0]["capabilities"] == {"streaming": True, "tools": True, "reasoning_content": False}


def test_usage_reports_month_and_remaining(env):
    client, token, _model, _ = env
    response = client.get("/api/v1/modeldesk/usage", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    body = response.json()
    assert body["billing_timezone"] == "Asia/Shanghai"
    assert body["limit_tokens"] == 10_000_000
    assert body["used_tokens"] == 0
    assert body["remaining_tokens"] == 10_000_000
    assert body["resets_at"].endswith("T00:00:00+08:00")


def test_models_requires_access_token(env):
    client, _token, _model, _ = env
    response = client.get("/api/v1/modeldesk/models")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_access_token"
