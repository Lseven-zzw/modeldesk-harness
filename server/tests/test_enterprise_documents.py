from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.auth.admin_session import require_browser_user, require_csrf
from app.auth.deps import require_access
from app.common.clock import utcnow
from app.db import get_session
from app.main import create_app
from app.models import Department, User, UserGroup, UserGroupMember


def test_document_access_and_revocation(db):
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_csrf] = lambda: None
    dept, group = Department(code="finance", name="Finance"), UserGroup(name="Reviewers")
    admin, finance, reviewer, employee = [
        User(username=name, display_name=name, role=role, department=department,
             password_hash="unused", status=1, created_at=utcnow())
        for name, role, department in (
            ("admin", "ADMIN", None), ("finance", "EMPLOYEE", "finance"),
            ("reviewer", "EMPLOYEE", None), ("employee", "EMPLOYEE", None),
        )
    ]
    db.add_all([dept, group, admin, finance, reviewer, employee])
    db.flush()
    db.add(UserGroupMember(group_id=group.id, user_id=reviewer.id))
    db.commit()
    client = TestClient(app)
    admin_path, client_path = "/api/admin/documents", "/api/v1/modeldesk/documents"
    assert client.get(client_path).status_code == 401
    app.dependency_overrides[require_browser_user] = lambda: employee
    assert client.get(admin_path).status_code == 403
    app.dependency_overrides[require_browser_user] = lambda: admin
    body = {
        "title": "报销制度", "content": "# 报销\n交通费需要发票。", "format": "markdown",
        "grants": [{"subject_type": "DEPARTMENT", "subject_id": dept.id},
                   {"subject_type": "GROUP", "subject_id": group.id}],
    }
    result = client.post(admin_path, json=body)
    assert result.status_code == 201
    document_id = result.json()["id"]
    assert "content" not in client.get(admin_path).json()["items"][0]
    for user, visible in ((finance, True), (reviewer, True), (employee, False)):
        app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=user)  # noqa: B023
        listing = client.get(client_path, params={"q": "发票"})
        assert listing.headers["cache-control"] == "no-store"
        assert bool(listing.json()["items"]) is visible
        assert client.get(f"{client_path}/{document_id}").status_code == (200 if visible else 404)
        assert client.get(client_path, params={"q": "%"}).json()["items"] == []
    replacement = {**body, "revision": 1, "grants": [{"subject_type": "USER", "subject_id": employee.id}]}
    assert client.put(f"{admin_path}/{document_id}", json=replacement).status_code == 200
    assert client.put(f"{admin_path}/{document_id}", json=replacement).status_code == 409
    assert client.get(f"{client_path}/{document_id}").json()["content"] == body["content"]
    app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=finance)
    assert client.get(f"{client_path}/{document_id}").status_code == 404
    assert client.put(f"{admin_path}/{document_id}", json={
        **replacement, "revision": 2, "enabled": False, "grants": [{"subject_type": "EVERYONE", "subject_id": 0}],
    }).status_code == 200
    assert client.get(client_path).json()["items"] == []
    public = {**body, "grants": [{"subject_type": "EVERYONE", "subject_id": 0}]}
    first_id = client.post(admin_path, json=public).json()["id"]
    second_id = client.post(admin_path, json=public).json()["id"]
    page = client.get(client_path, params={"q": "发票", "limit": 1}).json()
    assert [item["id"] for item in page["items"]] == [second_id]
    assert page["next_before"] == second_id
    next_page = client.get(client_path, params={"q": "发票", "limit": 1, "before": second_id}).json()
    assert [item["id"] for item in next_page["items"]] == [first_id]
    assert next_page["next_before"] is None


def test_expensive_upload_is_persisted_before_parse_and_can_retry(db, monkeypatch):
    from app import document_jobs

    admin = User(username="admin", display_name="Admin", role="ADMIN", password_hash="unused",
                 status=1, created_at=utcnow())
    db.add(admin)
    db.commit()
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_csrf] = lambda: None
    app.dependency_overrides[require_browser_user] = lambda: admin
    client = TestClient(app)
    base = "/api/admin/documents"
    upload = client.post(f"{base}/files", files={"file": ("notes.pdf", b"pdf", "application/pdf")})
    assert upload.status_code == 201
    row = upload.json()
    assert row["parse_status"] == "pending"
    assert client.get(f"{base}/{row['id']}/file").content == b"pdf"

    factory = sessionmaker(bind=db.get_bind())
    assert document_jobs.process_next_document(factory)
    db.expire_all()
    assert client.get(f"{base}/{row['id']}").json()["parse_status"] == "failed"
    assert client.post(f"{base}/{row['id']}/retry-parse").json()["parse_status"] == "pending"
    monkeypatch.setattr(document_jobs, "prepare_library_file",
                        lambda *_: ("notes.pdf", "application/pdf", "Meeting notes", "ready", "pdf"))
    assert document_jobs.process_next_document(factory)
    db.expire_all()
    result = client.get(f"{base}/{row['id']}").json()
    assert (result["parse_status"], result["content"], result["revision"]) == ("ready", "Meeting notes", 2)

def test_library_files_keep_original_and_enforce_current_access(db):
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_csrf] = lambda: None
    admin, first, second = [
        User(username=name, display_name=name, role=role, password_hash="unused",
             status=1, created_at=utcnow())
        for name, role in (("admin", "ADMIN"), ("first", "EMPLOYEE"), ("second", "EMPLOYEE"))
    ]
    db.add_all([admin, first, second])
    db.commit()
    app.dependency_overrides[require_browser_user] = lambda: admin
    employee = first
    app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=employee)
    client = TestClient(app)
    client_path = "/api/v1/modeldesk/documents"
    admin_path = "/api/admin/documents"
    payload = {"file": ("costs.csv", b"item,total\nTaxi,15", "text/csv")}
    personal = client.post(f"{client_path}/personal/files", files=payload)
    assert personal.status_code == 201
    personal_id = personal.json()["id"]
    assert client.get(f"{client_path}?library=personal&q=Taxi").json()["items"][0]["id"] == personal_id
    assert client.get(client_path).json()["items"] == []
    assert client.get(admin_path).json()["items"] == []
    assert client.get(f"{admin_path}/{personal_id}").status_code == 404
    assert client.get(f"{client_path}/{personal_id}/file?library=personal&revision=1").content == payload["file"][1]
    employee = second
    assert client.get(f"{client_path}?library=personal").json()["items"] == []
    assert client.get(f"{client_path}/{personal_id}/file?library=personal&revision=1").status_code == 404

    enterprise = client.post(f"{admin_path}/files", files=payload, data={
        "grants": '[{"subject_type":"EVERYONE","subject_id":0}]',
    })
    assert enterprise.status_code == 201
    document_id = enterprise.json()["id"]
    assert client.get(f"{client_path}/{document_id}/file?revision=1").content == payload["file"][1]
    assert client.get(f"{client_path}/{document_id}?revision=2").status_code == 409
    assert client.put(f"{admin_path}/{document_id}", json={
        "title": "Costs", "content": "Taxi,15", "format": "text", "revision": 1, "grants": [],
    }).status_code == 200
    assert client.get(f"{client_path}/{document_id}/file?revision=1").status_code == 404
