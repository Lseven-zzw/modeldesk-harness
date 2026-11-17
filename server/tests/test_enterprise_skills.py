from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.auth.admin_session import require_browser_user, require_csrf
from app.auth.deps import require_access
from app.common.clock import utcnow
from app.db import get_session
from app.main import create_app
from app.models import Department, EnterpriseSkillVersion, User, UserGroup, UserGroupMember


def test_enterprise_skill_publication_and_revocation(db):
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db
    dept = Department(code="design", name="Design")
    group = UserGroup(name="Reviewers")
    users = [
        User(username=name, password_hash="unused", display_name=name, role=role,
             department=department, status=1, created_at=utcnow())
        for name, role, department in [
            ("root", "ADMIN", None), ("designer", "EMPLOYEE", "design"),
            ("reviewer", "EMPLOYEE", None), ("guest", "EMPLOYEE", None),
        ]
    ]
    db.add_all([dept, group, *users])
    db.flush()
    db.add(UserGroupMember(group_id=group.id, user_id=users[2].id))
    db.commit()
    client = TestClient(app)
    assert client.get("/api/v1/modeldesk/skills").status_code == 401
    app.dependency_overrides[require_browser_user] = lambda: users[0]
    app.dependency_overrides[require_csrf] = lambda: None
    path = "/api/admin/skills/check-copy"
    draft = {
        "revision": 0, "description": 'Check: "copy"', "instructions": "# Review",
        "grants": [{"subject_type": "DEPARTMENT", "subject_id": dept.id},
                   {"subject_type": "GROUP", "subject_id": group.id}],
    }
    assert client.put(path, json=draft).status_code == 200
    assert client.put(path, json=draft).status_code == 409

    def visible(user):
        app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=user)
        response = client.get("/api/v1/modeldesk/skills")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        return response.json()["items"]

    [skill] = visible(users[1])
    assert skill["revision"] == 1 and 'name: check-copy' in skill["markdown"]
    assert visible(users[2]) == [skill]
    assert visible(users[3]) == []
    assert client.put(path, json={
        **draft, "revision": 1, "instructions": "# New revision",
        "grants": [{"subject_type": "USER", "subject_id": users[3].id}],
    }).status_code == 200
    assert visible(users[1]) == visible(users[2]) == []
    assert visible(users[3])[0]["revision"] == 2
    assert db.get(EnterpriseSkillVersion, ("check-copy", 1)).instructions == "# Review"
    assert client.put(path, json={
        **draft, "revision": 2, "enabled": False,
        "grants": [{"subject_type": "EVERYONE", "subject_id": 0}],
    }).status_code == 200
    assert visible(users[3]) == []


def test_editors_save_drafts_and_publishers_release_reviewed_revisions(db):
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_csrf] = lambda: None
    root, editor, publisher = [
        User(username=name, password_hash="unused", display_name=name, role=role, status=1,
             created_at=utcnow())
        for name, role in [("root", "ADMIN"), ("editor", "EMPLOYEE"), ("publisher", "EMPLOYEE")]
    ]
    db.add_all([root, editor, publisher])
    db.commit()
    actor = root
    app.dependency_overrides[require_browser_user] = lambda: actor
    app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=editor)
    client = TestClient(app)
    for user, capability in [(editor, "skills.edit"), (publisher, "skills.publish")]:
        assert client.put(f"/api/admin/roles/{user.username}", json={
            "name": user.username, "permissions": [capability],
        }).status_code == 200
        assert client.put(f"/api/admin/employees/{user.id}/roles", json={
            "items": [{"role": user.username, "department": None}],
        }).status_code == 200
    path = "/api/admin/skills/review-check"
    snapshot = {"revision": 0, "draft_revision": None, "description": "Review",
                "instructions": "# Draft one", "grants": [{"subject_type": "EVERYONE", "subject_id": 0}]}
    actor = editor
    first = client.put(f"{path}/draft", json=snapshot)
    assert first.status_code == 200
    assert first.json()["draft"]["category"] is None
    old = first.json()["draft"]["revision"]
    assert client.get("/api/v1/modeldesk/skills").json()["items"] == []
    assert client.post(f"{path}/publish", json={"revision": 0, "draft_revision": old}).status_code == 403
    assert client.put(path, json=snapshot).status_code == 403
    assert client.request("DELETE", f"{path}/draft", json={
        "revision": 0, "draft_revision": old,
    }).status_code == 200
    assert client.put(f"{path}/draft", json={**snapshot, "category": "unknown"}).status_code == 400
    latest = client.put(f"{path}/draft", json={
        **snapshot, "instructions": "# Draft two", "category": "development",
    }).json()["draft"]
    assert latest["revision"] != old
    actor = publisher
    assert client.put(f"{path}/draft", json=snapshot).status_code == 403
    assert client.post(f"{path}/publish", json={"revision": 0, "draft_revision": old}).status_code == 409
    published = client.post(f"{path}/publish", json={"revision": 0, "draft_revision": latest["revision"]})
    assert published.status_code == 200
    assert published.json()["draft"] is None and published.json()["published_by"] == publisher.id
    assert published.json()["category"] == "development"
    assert "# Draft two" in client.get("/api/v1/modeldesk/skills").json()["items"][0]["markdown"]
    actor = editor
    saved = client.put(f"{path}/draft", json={**snapshot, "revision": 1})
    assert saved.status_code == 200
    assert saved.json()["draft"]["category"] == "development"
    recategorized = client.put(f"{path}/draft", json={
        **snapshot, "revision": 1, "draft_revision": saved.json()["draft"]["revision"], "category": "content",
    }).json()
    assert recategorized["category"] == "development"
    assert recategorized["draft"]["category"] == "content"
    assert "# Draft two" in client.get("/api/v1/modeldesk/skills").json()["items"][0]["markdown"]
    assert client.post(f"{path}/unpublish", json={"revision": 1}).status_code == 403
    actor = publisher
    taken_down = client.post(f"{path}/unpublish", json={"revision": 1})
    assert taken_down.status_code == 200 and taken_down.json()["draft"] is not None
    assert client.get("/api/v1/modeldesk/skills").json()["items"] == []
    versions = client.get(f"{path}/versions").json()["items"]
    assert [item["revision"] for item in versions] == [2, 1]
    assert all(item["instructions"] == "# Draft two" for item in versions)
    assert all(item["category"] == "development" for item in versions)
