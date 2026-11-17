"""Minimal MCP Streamable HTTP client (protocol 2025-03-26).

One session per operation: initialize, then tools/list or tools/call. The
upstream credential never leaves the server; employees only ever see the
proxied result.
"""

import json

import httpx

from app.common.errors import ModelDeskError

PROTOCOL_VERSION = "2025-03-26"
MAX_TOOLS = 200
MAX_RESPONSE_BYTES = 2_097_152


class McpSession:
    def __init__(
        self, http: httpx.AsyncClient, endpoint: str, token: str | None, *, timeout: float = 30.0
    ):
        self._http = http
        self._endpoint = endpoint
        self._token = token
        self._timeout = timeout
        self._session_id: str | None = None
        self._next_id = 0

    async def initialize(self) -> None:
        result = await self._request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "modeldesk-server", "version": "0.1.0"},
        })
        if not isinstance(result, dict) or "protocolVersion" not in result:
            raise ModelDeskError(502, "upstream_error", "MCP 服务未返回有效的初始化结果")
        await self._notify("notifications/initialized")

    async def list_tools(self) -> list[dict]:
        tools: list[dict] = []
        cursor: str | None = None
        while True:
            result = await self._request("tools/list", {} if cursor is None else {"cursor": cursor})
            batch = result.get("tools") if isinstance(result, dict) else None
            if not isinstance(batch, list):
                raise ModelDeskError(502, "upstream_error", "MCP 服务返回了无效的工具列表")
            tools.extend(item for item in batch if isinstance(item, dict))
            if len(tools) > MAX_TOOLS:
                raise ModelDeskError(502, "upstream_error", f"MCP 服务工具数量超过 {MAX_TOOLS} 个上限")
            cursor = result.get("nextCursor") if isinstance(result, dict) else None
            if not isinstance(cursor, str) or not cursor:
                return tools

    async def call_tool(self, name: str, arguments: dict) -> dict:
        result = await self._request("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict) or not isinstance(result.get("content"), list):
            raise ModelDeskError(502, "upstream_error", "MCP 服务返回了无效的工具结果")
        return result

    async def _notify(self, method: str) -> None:
        await self._post({"jsonrpc": "2.0", "method": method}, expect_response=False)

    async def _request(self, method: str, params: dict) -> object:
        self._next_id += 1
        message = {"jsonrpc": "2.0", "id": self._next_id, "method": method, "params": params}
        result = await self._post(message, expect_response=True)
        if isinstance(result, dict) and isinstance(result.get("error"), dict):
            detail = result["error"].get("message")
            raise ModelDeskError(
                502, "upstream_error",
                f"MCP 服务报错：{detail}" if isinstance(detail, str) and detail else "MCP 服务拒绝了请求",
            )
        return result.get("result") if isinstance(result, dict) else None

    async def _post(self, payload: dict, *, expect_response: bool) -> dict | None:
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        }
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        if self._session_id is not None:
            headers["mcp-session-id"] = self._session_id
        try:
            async with self._http.stream(
                "POST", self._endpoint, json=payload, headers=headers,
                timeout=httpx.Timeout(self._timeout),
            ) as response:
                if response.status_code in (401, 403):
                    raise ModelDeskError(422, "invalid_request", "MCP 服务拒绝了访问凭据，请检查认证配置")
                if response.status_code == 202:
                    return None
                if response.status_code >= 400:
                    raise ModelDeskError(502, "upstream_error", f"MCP 服务返回 HTTP {response.status_code}")
                session_id = response.headers.get("mcp-session-id")
                if session_id:
                    self._session_id = session_id
                if not expect_response:
                    return None
                if response.headers.get("content-type", "").startswith("text/event-stream"):
                    return await self._read_sse(response)
                data = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=16384):
                    data.extend(chunk)
                    if len(data) > MAX_RESPONSE_BYTES:
                        raise ModelDeskError(502, "upstream_error", "MCP 服务响应过大")
        except ModelDeskError:
            raise
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise ModelDeskError(504, "upstream_timeout", "连接 MCP 服务超时，请检查服务地址") from exc
        except httpx.HTTPError as exc:
            raise ModelDeskError(502, "upstream_error", "无法连接 MCP 服务，请检查服务地址与网络") from exc
        try:
            message = json.loads(data)
        except ValueError as exc:
            raise ModelDeskError(502, "upstream_error", "MCP 服务返回了无法解析的响应") from exc
        return message if isinstance(message, dict) else None

    async def _read_sse(self, response: httpx.Response) -> dict | None:
        data = bytearray()
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            data.extend(line[5:].strip().encode())
            if len(data) > MAX_RESPONSE_BYTES:
                raise ModelDeskError(502, "upstream_error", "MCP 服务响应过大")
            try:
                message = json.loads(data)
            except ValueError:
                data.clear()
                continue
            data.clear()
            if isinstance(message, dict) and message.get("id") == self._next_id:
                return message
        raise ModelDeskError(502, "upstream_error", "MCP 服务的事件流未返回请求结果")