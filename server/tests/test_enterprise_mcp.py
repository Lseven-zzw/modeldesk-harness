import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.auth.admin_session import require_browser_user, require_csrf
from app.auth.deps import require_access
from app.common.clock import utcnow
from app.db import get_session
from app.main import create_app
from app.models import AuthorizationAudit, Department, User, UserGroup, UserGroupMember

TOOLS = [
    {"name": "search_tickets", "description": "Search support tickets",
     "inputSchema": {"type": "object", "properties": {"q": {"type": "string"}}},
     "annotations": {"readOnlyHint": True}},
    {"name": "create_ticket", "description": "Create a support ticket",
     "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}}},
    {"name": "boom", "description": "Always fails",
     "inputSchema": {"type": "object"}},
]


class FakeMcp:
    """A real-socket Streamable HTTP MCP server used as the upstream fixture."""

    def __init__(self, *, token="fixture-secret-token", sse=False, tools=None):
        self.token, self.sse = token, sse
        self.tools = TOOLS if tools is None else tools
        self.calls: list[tuple[str, dict, str | None]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                message = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                method = message.get("method")
                if outer.token is not None and self.headers.get("authorization") != f"Bearer {outer.token}":
                    self.send_response(401)
                    self.end_headers()
                    return
                if method == "notifications/initialized":
                    self.send_response(202)
                    self.end_headers()
                    return
                if method == "initialize":
                    result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}},
                              "serverInfo": {"name": "fixture", "version": "1.0"}}
                elif method == "tools/list":
                    result = {"tools": outer.tools}
                elif method == "tools/call":
                    params = message.get("params", {})
                    outer.calls.append((params.get("name"), params.get("arguments"),
                                        self.headers.get("mcp-session-id")))
                    if params.get("name") == "boom":
                        result = {"content": [{"type": "text", "text": "upstream failed"}], "isError": True}
                    else:
                        result = {"content": [{"type": "text", "text": f"called {params.get('name')}"}],
                                  "structuredContent": {"ok": True}}
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = json.dumps({"jsonrpc": "2.0", "id": message.get("id"), "result": result}).encode()
                self.send_response(200)
                self.send_header("mcp-session-id", "fixture-session")
                if outer.sse:
                    self.send_header("content-type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(f"event: message\ndata: {body.decode()}\n\n".encode())
                else:
                    self.send_header("content-type", "application/json")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.httpd.server_address[1]}/mcp"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def _users(db):
    dept, group = Department(code="finance", name="Finance"), UserGroup(name="Tools")
    admin, finance, member, employee = [
        User(username=name, display_name=name, role=role, department=department,
             password_hash="unused", status=1, created_at=utcnow())
        for name, role, department in (
            ("admin", "ADMIN", None), ("finance", "EMPLOYEE", "finance"),
            ("member", "EMPLOYEE", None), ("employee", "EMPLOYEE", None),
        )
    ]
    db.add_all([dept, group, admin, finance, member, employee])
    db.flush()
    db.add(UserGroupMember(group_id=group.id, user_id=member.id))
    db.commit()
    return SimpleNamespace(dept=dept, group=group, admin=admin, finance=finance, member=member, employee=employee)


def _setup(db, upstream=None):
    app = create_app(upstream_transport=upstream)
    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_csrf] = lambda: None
    app.dependency_overrides[require_browser_user] = lambda: db.get(User, 1)
    return app


def _body(endpoint, **overrides):
    return {
        "name": "工单系统", "endpoint": endpoint, "description": "公司工单服务",
        "guide": "## 用途\n查询和创建工单。", "token": "fixture-secret-token",
        "enabled": True, "grants": [{"subject_type": "EVERYONE", "subject_id": 0}],
        **overrides,
    }


def test_mcp_admin_lifecycle_masking_and_discovery(db):
    users = _users(db)
    upstream = FakeMcp()
    try:
        with TestClient(_setup(db)) as client:
            admin_path = "/api/admin/mcp"
            app = client.app
            app.dependency_overrides[require_browser_user] = lambda: users.employee
            assert client.get(admin_path).status_code == 403
            app.dependency_overrides[require_browser_user] = lambda: users.admin
            assert client.get(admin_path).status_code == 200

            created = client.post(admin_path, json=_body(upstream.endpoint))
            assert created.status_code == 201
            server = created.json()
            assert server["token_masked"] == "••••oken"
            assert "fixture-secret-token" not in created.text
            assert server["tools"] == [] and server["revision"] == 1

            assert client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": 99,
            }).status_code == 409
            renamed = client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": 1, "name": "工单平台", "token": None,
            })
            assert renamed.status_code == 200
            assert renamed.json()["token_masked"] == "••••oken"
            assert renamed.json()["revision"] == 2

            discovered = client.post(f"{admin_path}/{server['id']}/discover")
            assert discovered.status_code == 200
            tools = discovered.json()["tools"]
            assert [tool["name"] for tool in tools] == ["search_tickets", "create_ticket", "boom"]
            assert tools[0]["access"] == "read" and tools[1]["access"] == "write"
            assert all(tool["enabled"] is False for tool in tools)
            assert discovered.json()["discovered_at"] is not None

            assert client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": 3,
                "tools": [{"name": "missing_tool", "enabled": True, "access": "read"}],
            }).status_code == 400
            updated = client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": 3,
                "tools": [{"name": "search_tickets", "enabled": True, "access": "read"},
                          {"name": "create_ticket", "enabled": True, "access": "write"},
                          {"name": "boom", "enabled": True, "access": "write"}],
            })
            assert updated.status_code == 200
            assert all(tool["enabled"] for tool in updated.json()["tools"])

            again = client.post(f"{admin_path}/{server['id']}/discover").json()
            assert all(tool["enabled"] for tool in again["tools"])
            actions = [row.action for row in db.query(AuthorizationAudit).all()]
            assert actions.count("mcp.save") == 3 and actions.count("mcp.discover") == 2

            cleared = client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": again["revision"], "token": "",
            })
            assert cleared.json()["token_masked"] is None
            assert client.post(f"{admin_path}/{server['id']}/discover").status_code == 422
    finally:
        upstream.close()


def test_mcp_employee_visibility_call_and_revocation(db):
    users = _users(db)
    upstream = FakeMcp(sse=True)
    try:
        with TestClient(_setup(db)) as client:
            app = client.app
            admin_path, client_path = "/api/admin/mcp", "/api/v1/modeldesk/mcp"
            assert client.get(f"{client_path}/servers").status_code == 401
            server = client.post(admin_path, json=_body(upstream.endpoint, grants=[
                {"subject_type": "DEPARTMENT", "subject_id": users.dept.id},
                {"subject_type": "GROUP", "subject_id": users.group.id},
            ])).json()
            client.post(f"{admin_path}/{server['id']}/discover")
            client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": 2, "grants": [
                    {"subject_type": "DEPARTMENT", "subject_id": users.dept.id},
                    {"subject_type": "GROUP", "subject_id": users.group.id},
                ],
                "tools": [{"name": "search_tickets", "enabled": True, "access": "read"},
                          {"name": "create_ticket", "enabled": False, "access": "write"}],
            })
            for user, visible in ((users.finance, True), (users.member, True), (users.employee, False)):
                app.dependency_overrides[require_access] = lambda user=user: SimpleNamespace(user=user)
                listing = client.get(f"{client_path}/servers")
                assert listing.headers["cache-control"] == "no-store"
                items = listing.json()["items"]
                assert bool(items) is visible
                if visible:
                    assert items[0]["guide"].startswith("## 用途")
                    assert [tool["name"] for tool in items[0]["tools"]] == ["search_tickets"]
                    assert "endpoint" not in listing.text and "token" not in listing.text
                    assert "fixture-secret-token" not in listing.text

            app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=users.finance)
            denied = client.post(f"{client_path}/servers/{server['id']}/call",
                                 json={"tool": "create_ticket", "arguments": {"title": "x"}})
            assert denied.status_code == 404
            assert upstream.calls == []
            ok = client.post(f"{client_path}/servers/{server['id']}/call",
                             json={"tool": "search_tickets", "arguments": {"q": "网络"}})
            assert ok.status_code == 200
            assert ok.json() == {"content": [{"type": "text", "text": "called search_tickets"}],
                                 "is_error": False, "structured_content": {"ok": True}}
            assert upstream.calls == [("search_tickets", {"q": "网络"}, "fixture-session")]
            failed = client.post(f"{client_path}/servers/{server['id']}/call",
                                 json={"tool": "boom", "arguments": {}})
            assert failed.status_code == 404

            client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": 3,
                "grants": [{"subject_type": "USER", "subject_id": users.member.id}],
                "tools": [{"name": "search_tickets", "enabled": True, "access": "read"},
                          {"name": "create_ticket", "enabled": True, "access": "write"},
                          {"name": "boom", "enabled": True, "access": "write"}],
            })
            assert client.get(f"{client_path}/servers").json()["items"] == []
            assert client.post(f"{client_path}/servers/{server['id']}/call",
                               json={"tool": "search_tickets", "arguments": {}}).status_code == 404
            app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=users.member)
            assert client.post(f"{client_path}/servers/{server['id']}/call",
                               json={"tool": "create_ticket", "arguments": {"title": "新工单"}}).status_code == 200
            assert upstream.calls[-1][0] == "create_ticket"
            failed_call = client.post(f"{client_path}/servers/{server['id']}/call",
                                      json={"tool": "boom", "arguments": {}})
            assert failed_call.status_code == 200
            assert failed_call.json()["is_error"] is True
            assert failed_call.json()["content"] == [{"type": "text", "text": "upstream failed"}]

            client.put(f"{admin_path}/{server['id']}", json={
                **_body(upstream.endpoint), "revision": 4, "enabled": False,
                "grants": [{"subject_type": "EVERYONE", "subject_id": 0}],
            })
            assert client.get(f"{client_path}/servers").json()["items"] == []
            calls = db.query(AuthorizationAudit).filter(AuthorizationAudit.action == "mcp.call").all()
            assert [row.details["after"]["status"] for row in calls] == ["ok", "ok", "error"]
            assert all(row.actor_id in (users.finance.id, users.member.id) for row in calls)
    finally:
        upstream.close()


def test_mcp_discovery_and_call_failures(db):
    _users(db)
    dead = FakeMcp()
    dead_endpoint = dead.endpoint
    dead.close()
    upstream = FakeMcp(token="another-secret-token")
    try:
        with TestClient(_setup(db)) as client:
            admin_path, client_path = "/api/admin/mcp", "/api/v1/modeldesk/mcp"
            wrong = client.post(admin_path, json=_body(upstream.endpoint)).json()
            assert client.post(f"{admin_path}/{wrong['id']}/discover").status_code == 422
            unreachable = client.post(admin_path, json=_body(dead_endpoint, name="离线服务")).json()
            assert client.post(f"{admin_path}/{unreachable['id']}/discover").status_code == 502
            assert client.post(admin_path, json=_body("ftp://bad.example")).status_code == 400
            assert client.post(admin_path, json=_body(upstream.endpoint, token="short")).status_code == 400

            good = client.post(admin_path, json=_body(upstream.endpoint, name="可用服务",
                                                       token="another-secret-token")).json()
            client.post(f"{admin_path}/{good['id']}/discover")
            client.put(f"{admin_path}/{good['id']}", json={
                **_body(upstream.endpoint, token="another-secret-token"), "revision": 2,
                "tools": [{"name": "search_tickets", "enabled": True, "access": "read"}],
            })
            app = client.app
            app.dependency_overrides[require_access] = lambda: SimpleNamespace(user=db.get(User, 2))
            upstream.token = "rotated-secret-token"
            rejected = client.post(f"{client_path}/servers/{good['id']}/call",
                                   json={"tool": "search_tickets", "arguments": {}})
            assert rejected.status_code == 422
            assert "凭据" in rejected.json()["error"]["message"]
            calls = db.query(AuthorizationAudit).filter(AuthorizationAudit.action == "mcp.call").all()
            assert calls[-1].details["after"]["status"] == "error"
    finally:
        upstream.close()