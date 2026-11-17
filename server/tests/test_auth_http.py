import re

import pytest
from fastapi.testclient import TestClient

from app.common.clock import utcnow
from app.common.ids import pkce_s256
from app.common.passwords import hash_password
from app.main import create_app
from app.models import User

VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"


@pytest.fixture()
def client(db):
    app = create_app()
    app.dependency_overrides = {}
    # 让路由使用测试库：覆盖 get_session
    from app.db import get_session

    app.dependency_overrides[get_session] = lambda: db
    return TestClient(app, follow_redirects=False)


def test_desktop_landing_links_to_address_without_a_ticket(client):
    response = client.get("https://modeldesk.example.com/desktop-login")
    assert response.status_code == 200
    assert 'href="modeldesk://login?server=https%3A%2F%2Fmodeldesk.example.com"' in response.text


@pytest.fixture()
def admin(db):
    user = User(
        username="admin",
        password_hash=hash_password("admin-pass"),
        display_name="管理员",
        department=None,
        role="ADMIN",
        status=1,
        created_at=utcnow(),
    )
    db.add(user)
    db.commit()
    return user


def login(client):
    form = client.get("/admin/login")
    csrf = re.search(r'name="csrf" value="([^"]+)"', form.text).group(1)
    response = client.post(
        "/admin/login", data={"username": "admin", "password": "admin-pass", "csrf": csrf}
    )
    assert response.status_code == 302
    return client.get("/api/admin/csrf").json()["csrf"]


def start_tx(client):
    response = client.post(
        "/api/v1/modeldesk/authorizations",
        json={
            "client_id": "modeldesk-desktop",
            "redirect_uri": "http://127.0.0.1:49152/modeldesk/callback",
            "code_challenge": pkce_s256(VERIFIER),
            "code_challenge_method": "S256",
            "state": "N8x6LXw61DPlYNVoKm5rWOj2vbJmZiRK1CPIyw50HBs",
            "device_name": "金东-剪辑-01",
            "client_version": "1.0.0",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_authorize_requires_csrf(client, admin):
    login(client)
    tx = start_tx(client)
    response = client.post(
        "/api/v1/modeldesk/authorize", json={"auth_id": tx["auth_id"], "decision": "allow"}
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_full_http_login(client, admin):
    csrf = login(client)
    tx = start_tx(client)
    authorized = client.post(
        "/api/v1/modeldesk/authorize",
        json={"auth_id": tx["auth_id"], "decision": "allow"},
        headers={"X-CSRF-Token": csrf},
    )
    assert authorized.status_code == 200
    grant = authorized.json()
    assert grant["redirect_uri"] == "http://127.0.0.1:49152/modeldesk/callback"

    exchanged = client.post(
        "/api/v1/modeldesk/token",
        json={
            "grant_type": "identity_ticket",
            "identity_ticket": grant["identity_ticket"],
            "auth_id": tx["auth_id"],
            "code_verifier": VERIFIER,
        },
    )
    assert exchanged.status_code == 200
    tokens = exchanged.json()
    assert tokens["user"]["username"] == "admin"
    assert exchanged.headers["Cache-Control"] == "no-store"

    refreshed = client.post(
        "/api/v1/modeldesk/token",
        json={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]},
    )
    assert refreshed.status_code == 200
    assert refreshed.json()["refresh_token"] != tokens["refresh_token"]

    logged_out = client.post(
        "/api/v1/modeldesk/logout",
        headers={"Authorization": f"Bearer {refreshed.json()['access_token']}"},
    )
    assert logged_out.status_code == 204


def test_deny_returns_access_denied(client, admin):
    csrf = login(client)
    tx = start_tx(client)
    response = client.post(
        "/api/v1/modeldesk/authorize",
        json={"auth_id": tx["auth_id"], "decision": "deny"},
        headers={"X-CSRF-Token": csrf},
    )
    assert response.status_code == 200
    assert response.json()["error"] == "access_denied"


def test_desktop_login_redirects_anonymous_to_admin_login(client, admin):
    tx = start_tx(client)
    response = client.get(f"/desktop-login?auth_id={tx['auth_id']}", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"].startswith("/admin/login?next=")


def test_validation_errors_are_400_invalid_request(client):
    response = client.post("/api/v1/modeldesk/authorizations", json={"client_id": "x"})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_request"


def test_employee_can_authorize_desktop_but_cannot_access_admin(client, admin, db):
    admin.role = "EMPLOYEE"
    db.commit()
    tx = start_tx(client)
    desktop = f"/desktop-login?auth_id={tx['auth_id']}"
    redirect = client.get(desktop)
    form = client.get(redirect.headers["location"])
    csrf = re.search(r'name="csrf" value="([^"]+)"', form.text).group(1)
    logged_in = client.post(
        "/admin/login",
        data={"username": "admin", "password": "admin-pass", "csrf": csrf, "next": desktop},
    )
    assert logged_in.headers["location"] == desktop
    assert client.get("/api/admin/csrf").status_code == 403
    page = client.get(desktop)
    assert page.status_code == 200
    csrf = re.search(r'data-csrf="([^"]+)"', page.text).group(1)
    authorized = client.post(
        "/api/v1/modeldesk/authorize",
        json={"auth_id": tx["auth_id"], "decision": "allow"},
        headers={"X-CSRF-Token": csrf},
    )
    assert authorized.status_code == 200
    assert authorized.headers["Cache-Control"] == "no-store"


def test_admin_login_rejects_external_next(client, admin):
    form = client.get("/admin/login")
    csrf = re.search(r'name="csrf" value="([^"]+)"', form.text).group(1)
    response = client.post(
        "/admin/login",
        data={
            "username": "admin",
            "password": "admin-pass",
            "csrf": csrf,
            "next": "//other.example/",
        },
    )
    assert response.headers["location"] == "/admin/"
