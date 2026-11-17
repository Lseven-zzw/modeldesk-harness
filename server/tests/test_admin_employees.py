import re

from fastapi.testclient import TestClient

from app.auth.admin_session import require_browser_user, require_csrf
from app.common.clock import utcnow
from app.common.passwords import hash_password, verify_password
from app.db import get_session
from app.main import create_app
from app.models import SessionRow, User


def make_client(db, admin):
    app = create_app()

    def admin_override() -> User:
        return admin

    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_browser_user] = admin_override
    app.dependency_overrides[require_csrf] = lambda: None
    return TestClient(app)


def admin_user(db):
    row = User(
        username="admin",
        password_hash=hash_password("admin-password-1"),
        display_name="管理员",
        department=None,
        role="ADMIN",
        status=1,
        created_at=utcnow(),
    )
    db.add(row)
    db.commit()
    return row


def test_create_list_and_duplicate_username(db):
    admin = admin_user(db)
    client = make_client(db, admin)
    created = client.post(
        "/api/admin/employees",
        json={
            "username": "zhang.san",
            "display_name": "张三",
            "department": "剪辑部",
            "role": "EMPLOYEE",
            "password": "employee-pass-1",
        },
    )
    assert created.status_code == 201
    assert created.json()["username"] == "zhang.san"
    assert created.json()["status"] == 1

    duplicate = client.post(
        "/api/admin/employees",
        json={
            "username": "zhang.san",
            "display_name": "张三",
            "password": "employee-pass-1",
        },
    )
    assert duplicate.status_code == 400
    assert duplicate.json()["error"]["code"] == "invalid_request"

    listing = client.get("/api/admin/employees", params={"q": "剪辑"})
    assert listing.status_code == 200
    assert listing.json()["total"] == 1
    assert listing.json()["items"][0]["department"] == "剪辑部"


def test_patch_department_and_self_demotion_refused(db):
    admin = admin_user(db)
    employee = User(
        username="li.si",
        password_hash="x",
        display_name="李四",
        department="剪辑部",
        role="EMPLOYEE",
        status=1,
        created_at=utcnow(),
    )
    db.add(employee)
    db.commit()
    client = make_client(db, admin)

    patched = client.patch(
        f"/api/admin/employees/{employee.id}",
        json={"department": "策划部", "display_name": "李四四"},
    )
    assert patched.status_code == 200
    assert patched.json()["department"] == "策划部"
    assert patched.json()["display_name"] == "李四四"

    refused = client.patch(f"/api/admin/employees/{admin.id}", json={"role": "EMPLOYEE"})
    assert refused.status_code == 400
    assert "自己" in refused.json()["error"]["message"]


def test_disable_revokes_sessions_and_self_disable_refused(db):
    admin = admin_user(db)
    employee = User(
        username="wang.wu",
        password_hash="x",
        display_name="王五",
        department="剪辑部",
        role="EMPLOYEE",
        status=1,
        created_at=utcnow(),
    )
    db.add(employee)
    db.commit()
    db.add(
        SessionRow(
            id="gsess_01",
            user_id=employee.id,
            device_name="剪辑-01",
            client_version="1.0.0",
            access_hash="a" * 64,
            access_expires_at=utcnow(),
            refresh_family_id="gfam_01",
            absolute_expires_at=utcnow(),
            status="ACTIVE",
            created_at=utcnow(),
        )
    )
    db.commit()
    client = make_client(db, admin)

    response = client.post(f"/api/admin/employees/{employee.id}/status", json={"status": 0})
    assert response.status_code == 200
    assert response.json()["status"] == 0
    db.expire_all()
    assert db.get(SessionRow, "gsess_01").status == "REVOKED"

    refused = client.post(f"/api/admin/employees/{admin.id}/status", json={"status": 0})
    assert refused.status_code == 400


def test_reset_password_updates_hash_and_revokes_sessions(db):
    admin = admin_user(db)
    employee = User(
        username="zhao.liu",
        password_hash=hash_password("old-password-1"),
        display_name="赵六",
        department=None,
        role="EMPLOYEE",
        status=1,
        created_at=utcnow(),
    )
    db.add(employee)
    db.commit()
    db.add(
        SessionRow(
            id="gsess_02",
            user_id=employee.id,
            device_name=None,
            client_version=None,
            access_hash="b" * 64,
            access_expires_at=utcnow(),
            refresh_family_id="gfam_02",
            absolute_expires_at=utcnow(),
            status="ACTIVE",
            created_at=utcnow(),
        )
    )
    db.commit()
    client = make_client(db, admin)

    response = client.post(
        f"/api/admin/employees/{employee.id}/password", json={"password": "new-password-12"}
    )
    assert response.status_code == 204
    db.expire_all()
    assert verify_password(db.get(User, employee.id).password_hash, "new-password-12")
    assert db.get(SessionRow, "gsess_02").status == "REVOKED"


def test_short_password_rejected(db):
    admin = admin_user(db)
    client = make_client(db, admin)
    response = client.post(
        "/api/admin/employees",
        json={
            "username": "short.pw",
            "display_name": "短密码",
            "password": "123456",
        },
    )
    assert response.status_code == 400
    assert "12" in response.json()["error"]["message"]


def test_admin_session_and_employee_writes_require_cookie_and_csrf(db):
    admin = admin_user(db)
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db
    client = TestClient(app, follow_redirects=False)
    assert client.get("/api/admin/session").status_code == 401

    form = client.get("/admin/login")
    csrf = re.search(r'name="csrf" value="([^"]+)"', form.text).group(1)
    login = client.post(
        "/admin/login",
        data={"username": admin.username, "password": "admin-password-1", "csrf": csrf},
    )
    assert login.status_code == 302
    session = client.get("/api/admin/session")
    assert session.status_code == 200
    assert session.headers["Cache-Control"] == "no-store"
    assert session.json()["user"]["id"] == admin.id
    assert "password_hash" not in session.json()["user"]
    assert session.json()["csrf_token"] != csrf

    body = {"username": "new.staff", "display_name": "员工", "password": "employee-pass-1"}
    assert client.post("/api/admin/employees", json=body).status_code == 400
    created = client.post(
        "/api/admin/employees",
        json=body,
        headers={"X-CSRF-Token": session.json()["csrf_token"]},
    )
    assert created.status_code == 201
    assert created.headers["Cache-Control"] == "no-store"
