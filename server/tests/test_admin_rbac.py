import re

from fastapi.testclient import TestClient

from app.common.clock import utcnow
from app.common.passwords import hash_password
from app.db import get_session
from app.main import create_app
from app.models import Department, ModelCall, User


def test_roles_compose_and_revocation_applies_to_existing_session(db):
    app = create_app()

    def request_session():
        try:
            yield db
        except Exception:
            db.rollback()
            raise

    app.dependency_overrides[get_session] = request_session
    users = [
        User(
            username=name,
            display_name=name,
            department=department,
            role=role,
            password_hash=hash_password("test-password"),
            created_at=utcnow(),
        )
        for name, department, role in [
            ("root", None, "ADMIN"),
            ("operator", "A", "EMPLOYEE"),
            ("member-a", "A", "EMPLOYEE"),
            ("member-b", "B", "EMPLOYEE"),
        ]
    ]
    db.add_all(users)
    db.add_all([Department(code="A", name="部门 A"), Department(code="B", name="部门 B")])
    db.commit()

    def login(name):
        client = TestClient(app, follow_redirects=False)
        form = client.get("/admin/login")
        csrf = re.search(r'name="csrf" value="([^"]+)"', form.text).group(1)
        assert (
            client.post(
                "/admin/login",
                data={
                    "username": name,
                    "password": "test-password",
                    "csrf": csrf,
                },
            ).status_code
            == 302
        )
        return client, {"X-CSRF-Token": client.get("/api/admin/csrf").json()["csrf"]}

    db.add_all(
        ModelCall(
            request_id=f"call-{user.id}",
            user_id=user.id,
            session_id="session-test",
            model_id=1,
            model_code="test",
            billing_month="2026-11",
            status="SUCCESS",
            http_status=200,
            latency_ms=1,
            created_at=utcnow(),
        )
        for user in users[2:]
    )
    db.commit()

    root, headers = login("root")
    assert root.get("/api/admin/roles").status_code == 200
    created = root.post(
        "/api/admin/departments", headers=headers, json={"code": "empty", "name": "未分配成员"}
    )
    assert created.status_code == 201
    assert created.json()["members"] == 0
    assert "empty" in root.get("/api/admin/roles").json()["departments"]
    child = root.post("/api/admin/departments", headers=headers, json={
        "code": "child", "name": "Child", "parent_id": created.json()["id"],
    })
    assert child.status_code == 201
    assert child.json()["parent_id"] == created.json()["id"]
    child_path = f"/api/admin/departments/{child.json()['id']}"
    assert root.put(f"/api/admin/departments/{created.json()['id']}/status", headers=headers, json={
        "archived": True,
    }).status_code == 409
    assert root.put(f"{child_path}/status", headers=headers, json={"archived": True}).status_code == 200
    assert "child" not in root.get("/api/admin/roles").json()["departments"]
    assert root.put(f"{child_path}/status", headers=headers, json={"archived": False}).status_code == 200
    assert root.patch(f"/api/admin/departments/{created.json()['id']}", headers=headers, json={
        "name": "Parent", "parent_id": child.json()["id"],
    }).status_code == 400
    assert root.put("/api/admin/roles/employee", headers=headers, json={
        "name": "Employee", "permissions": [],
    }).status_code == 200
    assert (
        root.put(
            "/api/admin/roles/team",
            json={
                "name": "team",
                "permissions": ["employees.read"],
            },
        ).status_code
        == 400
    )
    for name, permissions in [
        ("team", ["employees.update", "employees.password"]),
        ("finance", ["usage.read"]),
    ]:
        assert (
            root.put(
                f"/api/admin/roles/{name}",
                headers=headers,
                json={
                    "name": name,
                    "permissions": permissions,
                },
            ).status_code
            == 200
        )
    new_employee = {
        "username": "new-employee",
        "display_name": "New employee",
        "password": "new-password",
        "department": "B",
        "assignments": [{"role": "missing", "department": "B"}],
    }
    assert root.post("/api/admin/employees", headers=headers, json=new_employee).status_code == 400
    created_employee = root.post("/api/admin/employees", headers=headers, json={
        **new_employee, "assignments": [{"role": "team", "department": "B"}],
    })
    assert created_employee.status_code == 201, created_employee.text
    new_path = f"/api/admin/employees/{created_employee.json()['id']}"
    assert root.get(f"{new_path}/roles").json()["items"] == [{"role": "team", "department": "B"}]
    assert root.patch(new_path, headers=headers, json={
        "display_name": "Should roll back", "assignments": [{"role": "missing"}],
    }).status_code == 400
    unchanged = root.get("/api/admin/employees?q=new-employee").json()["items"][0]
    assert unchanged["display_name"] == "New employee"
    assert root.patch(new_path, headers=headers, json={
        "display_name": "Edited employee", "assignments": [],
    }).status_code == 200
    assert root.get(f"{new_path}/roles").json()["items"] == []
    assignments = f"/api/admin/employees/{users[1].id}/roles"
    assert (
        root.put(
            assignments,
            headers=headers,
            json={
                "items": [
                    {"role": "team", "department": "A"},
                    {"role": "finance", "department": None},
                ]
            },
        ).status_code
        == 200
    )
    operator, token = login("operator")
    explanation_url = f"/api/admin/employees/{users[1].id}/effective-permissions"
    effective = root.get(explanation_url).json()["items"]
    assert any(
        item["permission"] == "employees.read" and item["role"] == "team"
        and item["department"] == "A" and item["granted_permission"] == "employees.update"
        for item in effective
    )
    assert operator.get(explanation_url).status_code == 403
    assert operator.get("/api/admin/authorization-audit").status_code == 403
    events = root.get("/api/admin/authorization-audit").json()["items"]
    assert any(event["action"] == "employee.roles" and event["actor_id"] == users[0].id
               for event in events)
    assert not any(event["action"] == "department.move" for event in events)
    assert operator.get("/api/admin/session").json()["permissions"] == [
        "employees.password",
        "employees.read",
        "employees.update",
        "usage.read",
    ]
    items = operator.get("/api/admin/employees").json()["items"]
    assert {item["username"] for item in items} == {"operator", "member-a"}
    [department] = operator.get("/api/admin/departments").json()["items"]
    assert department["code"] == "A" and department["members"] == 2
    path = f"/api/admin/departments/{department['id']}"
    assert operator.patch(path, headers=token, json={"name": "越权"}).status_code == 403
    assert root.patch(path, headers=headers, json={"name": "研发部"}).status_code == 200
    [renamed] = operator.get("/api/admin/departments").json()["items"]
    assert renamed == {**department, "name": "研发部"}
    assert {item["username"] for item in operator.get("/api/admin/employees").json()["items"]} == {
        "operator", "member-a"
    }
    summary = operator.get("/api/admin/usage/summary?month=2026-11").json()["items"]
    assert {item["user_id"] for item in summary} == {users[2].id, users[3].id}
    assert operator.get("/api/admin/models").status_code == 403
    assert operator.get("/api/admin/roles").status_code == 403
    employee_path = f"/api/admin/employees/{users[2].id}"
    assert operator.patch(employee_path, headers=token, json={
        "assignments": [{"role": "finance"}],
    }).status_code == 403
    assert operator.patch(employee_path, headers=token, json={"role": "ADMIN"}).status_code == 403
    assert operator.patch(employee_path, headers=token, json={"department": "B"}).status_code == 403
    assert (
        root.put(
            assignments,
            headers=headers,
            json={
                "items": [
                    {"role": "team", "department": "A"},
                    {"role": "finance", "department": "A"},
                ]
            },
        ).status_code
        == 200
    )
    calls = operator.get("/api/admin/usage/calls?month=2026-11").json()
    assert calls["total"] == 1
    assert calls["items"][0]["user_id"] == users[2].id
    summary = operator.get("/api/admin/usage/summary?month=2026-11").json()["items"]
    assert {item["user_id"] for item in summary} == {users[2].id}
    assert root.delete("/api/admin/roles/finance", headers=headers).status_code == 204
    assert operator.get("/api/admin/usage/summary").status_code == 403
    department_b = next(item for item in root.get("/api/admin/departments").json()["items"]
                        if item["code"] == "B")
    assert root.patch(child_path, headers=headers, json={
        "name": "Child", "parent_id": department_b["id"],
    }).status_code == 200
    group = root.post("/api/admin/user-groups", headers=headers, json={
        "name": "Scoped operators", "member_ids": [users[2].id],
        "assignments": [{"role": "team", "department": "B", "include_descendants": True}],
    })
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]
    grouped_employee, _ = login("member-a")
    assert {item["department"] for item in grouped_employee.get(
        "/api/admin/employees"
    ).json()["items"]} == {"B"}
    assert operator.post(f"{employee_path}/password", headers=token, json={
        "password": "new-password",
    }).status_code == 403
    grouped_sources = root.get(f"{employee_path}/effective-permissions").json()["items"]
    assert any(item["group_id"] == group_id and item["department"] == "B" for item in grouped_sources)
    assert any(item["group_id"] == group_id and item["department"] == "child"
               and item["scope_root"] == "B" for item in grouped_sources)
    assert root.patch(child_path, headers=headers, json={
        "name": "Child", "parent_id": None,
    }).status_code == 200
    assert not any(item["department"] == "child" for item in root.get(
        f"{employee_path}/effective-permissions"
    ).json()["items"])
    assert root.delete(f"/api/admin/user-groups/{group_id}", headers=headers).status_code == 204
    assert grouped_employee.get("/api/admin/session").status_code == 403
    for target in users[:2] + users[3:]:
        assert (
            operator.post(
                f"/api/admin/employees/{target.id}/password",
                headers=token,
                json={"password": "new-password"},
            ).status_code
            == 403
        )
    assert (
        operator.post(
            f"/api/admin/employees/{users[2].id}/password",
            headers=token,
            json={"password": "new-password"},
        ).status_code
        == 204
    )
    assert root.put(assignments, headers=headers, json={"items": []}).status_code == 200
    assert operator.get("/api/admin/session").status_code == 403
    assert root.get(explanation_url).json()["items"] == []

def test_employee_capabilities_show_overlapping_grants_and_current_access(db):
    from app.auth.admin_session import require_browser_user
    from app.models import EnterpriseDocument, EnterpriseDocumentGrant, UserGroup, UserGroupMember

    root = User(username="root", display_name="Root", role="ADMIN", password_hash="unused", created_at=utcnow())
    employee = User(username="staff", display_name="Staff", role="EMPLOYEE", password_hash="unused", created_at=utcnow())
    group = UserGroup(name="财务")
    db.add_all([root, employee, group])
    db.flush()
    document = EnterpriseDocument(title="报销制度", content="发票", format="text", enabled=True, revision=1,
                                  updated_by=root.id, updated_at=utcnow())
    db.add_all([document, UserGroupMember(group_id=group.id, user_id=employee.id)])
    db.flush()
    db.add_all([
        EnterpriseDocumentGrant(document_id=document.id, subject_type="GROUP", subject_id=group.id),
        EnterpriseDocumentGrant(document_id=document.id, subject_type="USER", subject_id=employee.id),
    ])
    db.commit()
    app = create_app()
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_browser_user] = lambda: root
    client = TestClient(app)
    path = f"/api/admin/employees/{employee.id}/effective-permissions"
    item = client.get(path).json()["capabilities"]["documents"][0]
    assert item["name"] == document.title
    assert {(source["type"], source["name"]) for source in item["sources"]} == {("USER", "Staff"), ("GROUP", "财务")}
    db.delete(db.get(UserGroupMember, (group.id, employee.id)))
    db.commit()
    assert [source["type"] for source in client.get(path).json()["capabilities"]["documents"][0]["sources"]] == ["USER"]
    employee.status = 0
    db.commit()
    assert not any(client.get(path).json()["capabilities"].values())
    app.dependency_overrides[require_browser_user] = lambda: employee
    assert client.get(path).status_code == 403
