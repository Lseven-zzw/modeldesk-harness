import httpx
from fastapi.testclient import TestClient

from app.auth.admin_session import require_browser_user, require_csrf
from app.common.clock import utcnow
from app.db import get_session
from app.main import create_app
from app.models import Department, User


def make_client(db, admin, upstream_transport=None):
    app = create_app(upstream_transport=upstream_transport)

    def admin_override() -> User:
        return admin

    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_browser_user] = admin_override
    app.dependency_overrides[require_csrf] = lambda: None
    return TestClient(app)


def admin_user(db):
    row = User(
        username="admin",
        password_hash="x",
        display_name="管理员",
        department=None,
        role="ADMIN",
        status=1,
        created_at=utcnow(),
    )
    db.add(row)
    db.commit()
    return row


MODEL = {
    "code": "qwen-max",
    "display_name": "阿里云 / qwen-max",
    "provider_name": "阿里云",
    "upstream_kind": "openai",
    "upstream_model": "qwen-max",
    "upstream_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "api_key": "fixture-abcd",
    "capabilities": "streaming,tools,ctx:131072",
}


def test_channel_discovery_batch_import_and_rotation(db):
    requests = []

    def upstream(request):
        requests.append(request)
        if request.url.host == "manual.example":
            return httpx.Response(404)
        return httpx.Response(200, json={"data": [{"id": "vendor/chat"}, {"id": "vendor/chat"}, {"id": "vendor/reasoner"}]})

    with make_client(db, admin_user(db), httpx.MockTransport(upstream)) as client:
        body = {"name": "团队网关", "upstream_base": "https://models.example/v1/", "api_key": "sk-original1234"}
        response = client.post("/api/admin/channels", json=body)
        assert response.status_code == 201
        assert "sk-original" not in response.text
        channel = f"/api/admin/channels/{response.json()['id']}"
        catalog = client.post(channel + "/discover")
        assert catalog.json() == {"supported": True, "items": ["vendor/chat", "vendor/reasoner"]}
        assert str(requests[-1].url) == "https://models.example/v1/models"
        assert requests[-1].headers["Authorization"] == "Bearer sk-original1234"

        response = client.post(channel + "/models", json={"models": ["vendor/chat", "vendor/reasoner", "custom"]})
        assert response.status_code == 201
        models = response.json()["items"]
        assert len(models) == 3 and models[0]["code"] == "vendor-chat"
        assert client.post(channel + "/models", json={"models": ["vendor/chat"]}).json() == {
            "items": [], "skipped": ["vendor/chat"]
        }
        assert client.patch(f"/api/admin/models/{models[0]['id']}", json={"api_key": "sk-override"}).status_code == 400
        assert client.patch(channel, json={"name": "团队网关", "upstream_base": "https://manual.example/v1"}).status_code == 400
        response = client.patch(channel, json={**body, "upstream_base": "https://manual.example/v1", "api_key": "test-5678"})
        assert response.status_code == 200
        assert client.post(channel + "/discover").json() == {"supported": False, "items": []}
        assert requests[-1].headers["Authorization"] == "Bearer test-5678"
        assert {row["api_key_masked"] for row in client.get("/api/admin/models").json()["items"]} == {"••••5678"}


def test_create_and_list_model_never_exposes_key(db):
    admin = admin_user(db)
    client = make_client(db, admin)
    created = client.post("/api/admin/models", json=MODEL)
    assert created.status_code == 201
    view = created.json()
    assert view["api_key_masked"] == "••••abcd"
    assert "fixture-abcd" not in str(view)

    listing = client.get("/api/admin/models")
    assert listing.status_code == 200
    assert listing.json()["upstream_kinds"] == ["openai"]
    assert listing.json()["items"][0]["api_key_masked"] == "••••abcd"


def test_model_delegation_is_limited_to_the_model_and_operation(db):
    admin = admin_user(db)
    root = make_client(db, admin)
    employee = User(username="operator", password_hash="x", display_name="Operator",
                    role="EMPLOYEE", status=1, created_at=utcnow())
    db.add(employee)
    db.commit()
    operator = make_client(db, employee)
    first = root.post("/api/admin/models", json=MODEL).json()["id"]
    second = root.post("/api/admin/models", json={**MODEL, "code": "other-model"}).json()["id"]
    delegation_path = f"/api/admin/models/{first}/delegations"
    subject = {"subject_type": "USER", "subject_id": employee.id}
    assignments = {"revision": 0, "upsert": [{**subject, "permissions": ["models.update", "grants.read"]}]}
    assert operator.get("/api/admin/session").status_code == 403
    assert operator.get("/api/admin/channels").status_code == 403
    assert operator.post("/api/admin/channels/1/discover").status_code == 403
    assert root.patch(delegation_path, json=assignments).status_code == 200
    stale = root.patch(delegation_path, json={"revision": 0, "remove": [subject]})
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "revision_conflict"
    session = operator.get("/api/admin/session").json()
    assert session["permissions"] == []
    assert session["model_permissions"][str(first)] == ["grants.read", "models.read", "models.update"]
    assert [row["id"] for row in operator.get("/api/admin/models").json()["items"]] == [first]
    assert [row["id"] for row in operator.get("/api/admin/access-options").json()["models"]] == [first]
    assert operator.patch(f"/api/admin/models/{first}", json={"display_name": "Allowed"}).status_code == 200
    assert operator.patch(f"/api/admin/models/{second}", json={"display_name": "Denied"}).status_code == 403
    assert operator.post(f"/api/admin/models/{first}/status", json={"status": 0}).status_code == 403
    assert operator.get(f"/api/admin/models/{first}/grants").status_code == 200
    assert operator.get(f"/api/admin/models/{second}/grants").status_code == 403
    assert operator.put(f"/api/admin/models/{first}/grants", json={"grants": []}).status_code == 403
    assert operator.patch(delegation_path, json=assignments).status_code == 403
    assert operator.get("/api/admin/credit-rules").status_code == 403
    assert root.patch(delegation_path, json={"revision": 1, "remove": [subject]}).status_code == 200
    assert operator.get("/api/admin/session").status_code == 403
    assert operator.get("/api/admin/models").status_code == 403


def test_department_and_group_model_grants_can_be_revoked_independently(db):
    root = make_client(db, admin_user(db))
    parent = root.post("/api/admin/departments", json={"code": "parent", "name": "Parent"}).json()
    child = root.post("/api/admin/departments", json={
        "code": "child", "name": "Child", "parent_id": parent["id"],
    }).json()
    employee = User(username="member", password_hash="x", display_name="Member",
                    department=child["code"], role="EMPLOYEE", status=1, created_at=utcnow())
    db.add(employee)
    db.commit()
    group = root.post("/api/admin/user-groups", json={
        "name": "Operators", "member_ids": [employee.id], "assignments": [],
    }).json()
    operator = make_client(db, employee)
    model = root.post("/api/admin/models", json=MODEL).json()["id"]
    path = f"/api/admin/models/{model}/delegations"
    department = {"subject_type": "DEPARTMENT", "subject_id": parent["id"]}
    team = {"subject_type": "GROUP", "subject_id": group["id"]}
    grant = {"revision": 0, "upsert": [
        {**department, "include_descendants": True, "permissions": ["models.update"]},
        {**team, "permissions": ["grants.read"]},
    ]}
    assert root.patch(path, json=grant).status_code == 200
    report = root.get(f"/api/admin/employees/{employee.id}/effective-permissions").json()["model_items"]
    assert {row["subject_type"] for row in report} == {"DEPARTMENT", "GROUP"}
    assert operator.patch(f"/api/admin/models/{model}", json={"display_name": "Allowed"}).status_code == 200
    assert operator.get(f"/api/admin/models/{model}/grants").status_code == 200
    assert root.patch(path, json={"revision": 1, "remove": [department]}).status_code == 200
    assert operator.patch(f"/api/admin/models/{model}", json={"display_name": "Denied"}).status_code == 403
    assert operator.get(f"/api/admin/models/{model}/grants").status_code == 200
    assert root.delete(f"/api/admin/user-groups/{group['id']}").status_code == 204
    assert root.get(path).json()["revision"] == 3
    assert root.get(path).json()["items"] == []
    assert operator.get("/api/admin/session").status_code == 403


def test_unregistered_upstream_kind_rejected(db):
    admin = admin_user(db)
    client = make_client(db, admin)
    response = client.post("/api/admin/models", json={**MODEL, "upstream_kind": "anthropic"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "unsupported_parameter"


def test_patch_without_key_keeps_cipher_and_with_key_rotates_hint(db):
    from app.models import ModelRow

    admin = admin_user(db)
    client = make_client(db, admin)
    model_id = client.post("/api/admin/models", json=MODEL).json()["id"]
    db.expire_all()
    before = bytes(db.get(ModelRow, model_id).api_key_cipher)

    unchanged = client.patch(
        f"/api/admin/models/{model_id}", json={"display_name": "qwen-max 主模型"}
    )
    assert unchanged.status_code == 200
    assert unchanged.json()["display_name"] == "qwen-max 主模型"
    assert unchanged.json()["api_key_masked"] == "••••abcd"
    db.expire_all()
    assert bytes(db.get(ModelRow, model_id).api_key_cipher) == before

    rotated = client.patch(f"/api/admin/models/{model_id}", json={"api_key": "sk-new-key-9999"})
    assert rotated.json()["api_key_masked"] == "••••9999"
    db.expire_all()
    assert bytes(db.get(ModelRow, model_id).api_key_cipher) != before


def test_grants_replace_validates_and_dedupes(db):
    admin = admin_user(db)
    client = make_client(db, admin)
    employee = User(
        username="zhang.san",
        password_hash="x",
        display_name="张三",
        department="剪辑部",
        role="EMPLOYEE",
        status=1,
        created_at=utcnow(),
    )
    db.add(employee)
    db.add(Department(code="empty", name="Empty department"))
    db.commit()
    model_id = client.post("/api/admin/models", json=MODEL).json()["id"]

    response = client.put(
        f"/api/admin/models/{model_id}/grants",
        json={
            "grants": [
                {"subject_type": "EVERYONE", "subject_id": "*"},
                {"subject_type": "EVERYONE", "subject_id": "*"},
                {"subject_type": "DEPARTMENT", "subject_id": "剪辑部"},
                {"subject_type": "DEPARTMENT", "subject_id": "empty"},
                {"subject_type": "USER", "subject_id": str(employee.id)},
            ]
        },
    )
    assert response.status_code == 200
    assert len(response.json()["grants"]) == 4

    bad = client.put(
        f"/api/admin/models/{model_id}/grants",
        json={"grants": [{"subject_type": "DEPARTMENT", "subject_id": "不存在部"}]},
    )
    assert bad.status_code == 400
    still = client.get(f"/api/admin/models/{model_id}/grants").json()["grants"]
    assert len(still) == 4


def test_credit_rule_validation_and_duplicate(db):
    admin = admin_user(db)
    client = make_client(db, admin)
    rule = {
        "subject_type": "DEFAULT",
        "subject_id": "*",
        "model_id": 0,
        "monthly_token_limit": 10_000_000,
    }
    assert client.post("/api/admin/credit-rules", json=rule).status_code == 201
    assert client.post("/api/admin/credit-rules", json=rule).status_code == 400
    assert (
        client.post("/api/admin/credit-rules", json={**rule, "subject_id": "剪辑部"}).status_code
        == 400
    )
    assert (
        client.post("/api/admin/credit-rules", json={**rule, "monthly_token_limit": -1}).status_code
        == 400
    )
