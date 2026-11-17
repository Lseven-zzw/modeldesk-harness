import json
import re
from typing import Annotated, Literal
from urllib.parse import urlparse

from anyio import fail_after
from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.admin.authorization_audit import record_change
from app.admin.rbac import Access
from app.admin.resource_audience import ResourceAudience, audience_options, validate_audience
from app.admin.routes_employees import _no_store
from app.auth.admin_session import require_csrf, require_permission
from app.auth.deps import require_access
from app.auth.service import Authenticated
from app.common.clock import utcnow
from app.common.crypto import SecretBox
from app.common.errors import ModelDeskError
from app.db import get_session
from app.mcp.client import McpSession
from app.models import Department, User, UserGroupMember
from app.models import EnterpriseMcpServer as McpServer
from app.settings import get_settings

admin_router = APIRouter(prefix="/api/admin/mcp", dependencies=[Depends(_no_store)])
client_router = APIRouter(prefix="/api/v1/modeldesk/mcp", dependencies=[Depends(_no_store)])
DB = Annotated[Session, Depends(get_session)]
Reader = Annotated[Access, Depends(require_permission("mcp.read"))]
Manager = Annotated[Access, Depends(require_permission("mcp.manage"))]
Employee = Annotated[Authenticated, Depends(require_access)]
ServerID = Annotated[int, Path(gt=0, le=2**63 - 1)]
TOOL_NAME = re.compile(r"[A-Za-z0-9_-]{1,128}")
MAX_SCHEMA_BYTES = 16_000
MAX_ARGUMENTS_BYTES = 65_536
MAX_RESULT_BYTES = 1_048_576


class ToolPolicy(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    enabled: bool
    access: Literal["read", "write"]


class McpBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    endpoint: str = Field(min_length=1, max_length=512)
    description: str = Field(default="", max_length=4_000)
    guide: str = Field(default="", max_length=20_000)
    token: str | None = Field(default=None, max_length=512)
    enabled: bool = True
    grants: list[ResourceAudience] = Field(max_length=500)


class McpUpdate(McpBody):
    revision: int = Field(gt=0, lt=2**31 - 1)
    tools: list[ToolPolicy] | None = Field(default=None, max_length=200)


class McpCall(BaseModel):
    tool: str = Field(min_length=1, max_length=128)
    arguments: dict = Field(default_factory=dict)


def _missing() -> ModelDeskError:
    return ModelDeskError(404, "invalid_request", "MCP 服务不存在或不可访问")


def _endpoint(value: str) -> str:
    cleaned = value.strip().rstrip("/")
    try:
        parsed = urlparse(cleaned)
        port = parsed.port
    except ValueError as exc:
        raise ModelDeskError(400, "invalid_request", "MCP 服务地址不合法") from exc
    if (
        len(cleaned) > 512
        or parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or port == 0
        or any(c.isspace() for c in cleaned)
        or any(c in cleaned for c in "?#" + chr(92))
    ):
        raise ModelDeskError(
            400, "invalid_request", "MCP 服务地址必须是 http(s) 地址，且只包含主机、端口和路径"
        )
    return cleaned


def _encrypt_token(token: str) -> bytes:
    cleaned = token.strip()
    if len(cleaned) < 8:
        raise ModelDeskError(400, "invalid_request", "访问凭据过短")
    if len(cleaned.encode()) > 484 or any(not 33 <= ord(c) <= 126 for c in cleaned):
        raise ModelDeskError(400, "invalid_request", "访问凭据过长或包含非法字符")
    return SecretBox(get_settings().master_key).encrypt(cleaned)


def _decrypt_token(row: McpServer) -> str | None:
    if row.token_cipher is None:
        return None
    return SecretBox(get_settings().master_key).decrypt(row.token_cipher)


def _view(row: McpServer) -> dict:
    token = _decrypt_token(row)
    return {
        "id": row.id, "name": row.name, "endpoint": row.endpoint,
        "description": row.description, "guide": row.guide,
        "token_masked": None if token is None else f"••••{token[-4:]}",
        "enabled": row.enabled, "revision": row.revision,
        "grants": row.grants, "tools": row.tools,
        "discovered_at": None if row.discovered_at is None else row.discovered_at.isoformat() + "Z",
    }


def _normalize_tool(raw: dict) -> dict | None:
    name = raw.get("name")
    if not isinstance(name, str) or TOOL_NAME.fullmatch(name) is None:
        return None
    description = raw.get("description")
    description = description[:2_000] if isinstance(description, str) else ""
    schema = raw.get("inputSchema")
    if not isinstance(schema, dict):
        schema = {"type": "object"}
    try:
        if len(json.dumps(schema, ensure_ascii=False).encode()) > MAX_SCHEMA_BYTES:
            return None
    except ValueError:
        return None
    annotations = raw.get("annotations")
    read_only = isinstance(annotations, dict) and annotations.get("readOnlyHint") is True
    return {
        "name": name, "description": description, "input_schema": schema,
        "access": "read" if read_only else "write", "enabled": False,
    }


def _audience_ids(db: Session, user: User) -> tuple[set[int], set[int]]:
    departments: set[int] = set()
    if user.department:
        departments = set(db.scalars(select(Department.id).where(
            Department.code == user.department, Department.archived.is_(False)
        )))
    groups = set(db.scalars(select(UserGroupMember.group_id).where(UserGroupMember.user_id == user.id)))
    return departments, groups


def matching_grants(grants: list[dict], user: User, departments: set[int], groups: set[int]) -> list[dict]:
    return [grant for grant in grants if
            grant.get("subject_type") == "EVERYONE"
            or (grant.get("subject_type") == "USER" and grant.get("subject_id") == user.id)
            or (grant.get("subject_type") == "DEPARTMENT" and grant.get("subject_id") in departments)
            or (grant.get("subject_type") == "GROUP" and grant.get("subject_id") in groups)]


def _matches(grants: list[dict], user: User, departments: set[int], groups: set[int]) -> bool:
    return bool(matching_grants(grants, user, departments, groups))


def _save(db: Session, row: McpServer, body: McpBody, actor_id: int, previous: dict | None) -> dict:
    name = body.name.strip()
    if not name:
        raise ModelDeskError(400, "invalid_request", "服务名称不能为空")
    grants = validate_audience(db, body.grants)
    row.name, row.endpoint = name, _endpoint(body.endpoint)
    row.description, row.guide, row.enabled = body.description, body.guide, body.enabled
    if body.token is not None:
        row.token_cipher = _encrypt_token(body.token) if body.token.strip() else None
    if isinstance(body, McpUpdate) and body.tools is not None:
        known = {tool["name"] for tool in row.tools}
        policies = {}
        for policy in body.tools:
            if policy.name not in known or policy.name in policies:
                raise ModelDeskError(400, "invalid_request", "工具策略包含未知或重复的工具，请先测试连接")
            policies[policy.name] = policy
        row.tools = [
            {**tool, "enabled": policies[tool["name"]].enabled, "access": policies[tool["name"]].access}
            if tool["name"] in policies else tool
            for tool in row.tools
        ]
    row.grants = [{"subject_type": kind, "subject_id": subject} for kind, subject in sorted(grants)]
    row.revision = previous["revision"] + 1 if previous else 1
    db.add(row)
    db.flush()
    record_change(db, actor_id, "mcp.save", str(row.id), previous, _view(row))
    db.commit()
    return _view(row)


@admin_router.get("")
def list_servers(_access: Reader, db: DB) -> dict:
    rows = db.scalars(select(McpServer).order_by(McpServer.id))
    return {"items": [_view(row) for row in rows]}


@admin_router.get("/audience-options")
def mcp_audience_options(_access: Manager, db: DB) -> dict:
    return audience_options(db)


@admin_router.get("/{server_id}")
def view_server(server_id: ServerID, _access: Reader, db: DB) -> dict:
    row = db.get(McpServer, server_id)
    if row is None:
        raise _missing()
    return _view(row)


@admin_router.post("", status_code=201, dependencies=[Depends(require_csrf)])
def create_server(body: McpBody, access: Manager, db: DB) -> dict:
    row = McpServer(grants=[], tools=[], discovered_at=None)
    return _save(db, row, body, access.user.id, None)


@admin_router.put("/{server_id}", dependencies=[Depends(require_csrf)])
def update_server(server_id: ServerID, body: McpUpdate, access: Manager, db: DB) -> dict:
    row = db.get(McpServer, server_id, with_for_update=True)
    if row is None:
        raise _missing()
    if row.revision != body.revision:
        raise ModelDeskError(409, "revision_conflict", "MCP 服务配置已更新，请重新打开后编辑")
    return _save(db, row, body, access.user.id, _view(row))


@admin_router.post("/{server_id}/discover", dependencies=[Depends(require_csrf)])
async def discover_tools(server_id: ServerID, request: Request, access: Manager, db: DB) -> dict:
    row = db.get(McpServer, server_id, with_for_update=True)
    if row is None:
        raise _missing()
    previous = _view(row)
    session = McpSession(request.app.state.upstream, row.endpoint, _decrypt_token(row), timeout=15.0)
    with fail_after(30):
        await session.initialize()
        raw_tools = await session.list_tools()
    merged = []
    old = {tool["name"]: tool for tool in row.tools}
    for raw in raw_tools:
        tool = _normalize_tool(raw)
        if tool is None:
            continue
        if tool["name"] in old:
            tool["enabled"] = bool(old[tool["name"]].get("enabled"))
            tool["access"] = old[tool["name"]].get("access", tool["access"])
        merged.append(tool)
    row.tools, row.discovered_at, row.revision = merged, utcnow(), row.revision + 1
    record_change(db, access.user.id, "mcp.discover", str(row.id), previous, _view(row))
    db.commit()
    return _view(row)


def _visible_server(db: Session, user: User, server_id: int) -> McpServer:
    row = db.get(McpServer, server_id)
    departments, groups = _audience_ids(db, user)
    if row is None or not row.enabled or not _matches(row.grants, user, departments, groups):
        raise _missing()
    return row


@client_router.get("/servers")
def list_my_servers(auth: Employee, db: DB) -> JSONResponse:
    departments, groups = _audience_ids(db, auth.user)
    items = []
    for row in db.scalars(select(McpServer).where(McpServer.enabled.is_(True)).order_by(McpServer.id)):
        if not _matches(row.grants, auth.user, departments, groups):
            continue
        items.append({
            "id": row.id, "name": row.name, "description": row.description,
            "guide": row.guide, "revision": row.revision,
            "tools": [
                {"name": tool["name"], "description": tool["description"],
                 "input_schema": tool["input_schema"], "access": tool["access"]}
                for tool in row.tools if tool.get("enabled")
            ],
        })
    return JSONResponse({"items": items}, headers={"Cache-Control": "no-store"})


def _audit_call(db: Session, user_id: int, row: McpServer, tool: str, status: str) -> None:
    record_change(db, user_id, "mcp.call", str(row.id), None, {
        "server": row.name, "tool": tool, "status": status,
    })
    db.commit()


@client_router.post("/servers/{server_id}/call")
async def call_tool(
    server_id: ServerID, body: McpCall, request: Request, auth: Employee, db: DB
) -> JSONResponse:
    row = _visible_server(db, auth.user, server_id)
    tool = next((t for t in row.tools if t["name"] == body.tool and t.get("enabled")), None)
    if tool is None:
        raise ModelDeskError(404, "invalid_request", "工具不存在或未开放")
    if len(json.dumps(body.arguments, ensure_ascii=False).encode()) > MAX_ARGUMENTS_BYTES:
        raise ModelDeskError(400, "invalid_request", "工具参数过大")
    session = McpSession(request.app.state.upstream, row.endpoint, _decrypt_token(row), timeout=120.0)
    try:
        with fail_after(300):
            await session.initialize()
            result = await session.call_tool(body.tool, body.arguments)
    except ModelDeskError:
        _audit_call(db, auth.user.id, row, body.tool, "error")
        raise
    content = [block for block in result["content"] if isinstance(block, dict)]
    payload: dict = {"content": content, "is_error": result.get("isError") is True}
    if isinstance(result.get("structuredContent"), (dict, list)):
        payload["structured_content"] = result["structuredContent"]
    if len(json.dumps(payload, ensure_ascii=False).encode()) > MAX_RESULT_BYTES:
        _audit_call(db, auth.user.id, row, body.tool, "error")
        raise ModelDeskError(502, "upstream_error", "工具结果过大，请缩小查询范围")
    _audit_call(db, auth.user.id, row, body.tool, "error" if payload["is_error"] else "ok")
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})