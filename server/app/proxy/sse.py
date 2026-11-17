import json
from collections.abc import AsyncIterator

import httpx

from app.common.errors import ModelDeskError


async def frames(response: httpx.Response) -> AsyncIterator[tuple[str, dict | str | None]]:
    lines: list[str] = []
    async for line in response.aiter_lines():
        if line:
            lines.append(line)
        elif lines:
            yield _decode_frame(lines)
            lines.clear()
    if lines:
        yield _decode_frame(lines)


def _decode_frame(lines: list[str]) -> tuple[str, dict | str | None]:
    data = "\n".join(line[5:].removeprefix(" ") for line in lines if line.startswith("data:"))
    raw = "\n".join(lines) + "\n\n"
    if not data:
        return raw, None
    if data == "[DONE]":
        return raw, data
    try:
        payload = json.loads(data)
    except ValueError:
        return "", None
    if not isinstance(payload, dict):
        return "", None
    if "error" in payload:
        raise ModelDeskError(502, "upstream_error", "上游模型服务暂时不可用")
    return raw, payload


class Completion:
    def __init__(self) -> None:
        self.metadata: dict = {}
        self.message: dict = {"role": "assistant"}
        self.finish_reason = None
        self.tools: dict[int, dict] = {}

    def add(self, payload: dict) -> None:
        for key in ("id", "created", "model", "system_fingerprint"):
            if key in payload:
                self.metadata[key] = payload[key]
        for choice in payload.get("choices") or []:
            delta = choice.get("delta") or {}
            for field in ("content", "reasoning_content", "refusal"):
                if isinstance(delta.get(field), str):
                    self.message[field] = self.message.get(field, "") + delta[field]
            for tool in delta.get("tool_calls") or []:
                entry = self.tools.setdefault(tool["index"], {"type": "function", "function": {}})
                if "id" in tool:
                    entry["id"] = tool["id"]
                for key, value in (tool.get("function") or {}).items():
                    if key in {"name", "arguments"} and isinstance(value, str):
                        entry["function"][key] = entry["function"].get(key, "") + value
            if choice.get("finish_reason") is not None:
                self.finish_reason = choice["finish_reason"]

    def payload(self, usage: dict | None) -> dict:
        if self.finish_reason is None:
            raise ModelDeskError(502, "upstream_error", "上游模型服务返回了不完整的响应")
        self.message.setdefault("content", None)
        if self.tools:
            self.message["tool_calls"] = [self.tools[index] for index in sorted(self.tools)]
        result = {
            **self.metadata,
            "object": "chat.completion",
            "choices": [{"index": 0, "message": self.message, "finish_reason": self.finish_reason}],
        }
        if usage is not None:
            result["usage"] = usage
        return result
