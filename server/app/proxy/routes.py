import asyncio
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated

import httpx
from anyio import CancelScope, to_thread
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.types import Receive, Scope, Send

from app.auth.deps import require_access
from app.auth.service import Authenticated
from app.common.clock import billing_month, utcnow
from app.common.crypto import SecretBox
from app.common.errors import ModelDeskError, error_body
from app.model.visibility import parse_model_ref, require_model_visible
from app.proxy.settle import settle_call
from app.proxy.sse import Completion, frames
from app.proxy.upstreams.base import Usage
from app.proxy.upstreams.registry import get_adapter
from app.proxy.whitelist import validate_chat_payload
from app.quota.service import admission
from app.settings import get_settings

router = APIRouter(prefix="/api/v1/modeldesk")
NO_STORE = {"Cache-Control": "no-store"}


@dataclass
class Call:
    request_id: str
    user_id: int
    session_id: str
    model_id: int
    month: str
    started: float
    model_code: str = ""
    usage: Usage | None = None
    status: str = "SUCCESS"
    http_status: int = 200
    stream_complete: bool = False

    def cancel(self) -> None:
        if self.status == "SUCCESS" and not self.stream_complete:
            self.status = "CLIENT_CANCELLED"
            self.http_status = 499

    def fail(self, exc: ModelDeskError) -> None:
        self.http_status = exc.status
        self.status = {
            400: "INVALID_REQUEST",
            403: "MODEL_NOT_ALLOWED",
            429: "BLOCKED_QUOTA",
            504: "UPSTREAM_TIMEOUT",
        }.get(exc.status, "UPSTREAM_ERROR")

    async def finish(self, session_factory) -> None:
        def write() -> None:
            settle_call(
                request_id=self.request_id,
                user_id=self.user_id,
                session_id=self.session_id,
                model_id=self.model_id,
                model_code=self.model_code or (f"modeldesk:{self.model_id}" if self.model_id else ""),
                month=self.month,
                status=self.status,
                http_status=self.http_status,
                latency_ms=int((time.monotonic() - self.started) * 1000),
                input_tokens=self.usage.input_tokens if self.usage else None,
                output_tokens=self.usage.output_tokens if self.usage else None,
                cached_tokens=self.usage.cached_tokens if self.usage else None,
                now=utcnow(),
                session_factory=session_factory,
            )

        await to_thread.run_sync(write)


def _prepare(call, auth, payload, session_factory, now):
    with session_factory() as db:
        model = require_model_visible(db, auth.user, call.model_id)
        call.model_code = model.code
        admission(db, auth.user, call.model_id, now)
        connection = model.channel or model
        adapter = get_adapter(connection.upstream_kind)
        key = SecretBox(get_settings().master_key).decrypt(connection.api_key_cipher)
        return adapter, adapter.build(model, key, payload, call.request_id, upstream_base=connection.upstream_base)


def _upstream_error() -> ModelDeskError:
    return ModelDeskError(502, "upstream_error", "上游模型服务暂时不可用")


def _timeout() -> ModelDeskError:
    return ModelDeskError(504, "upstream_timeout", "上游模型服务响应超时")


async def _open(client, prepared):
    outbound = client.build_request(
        "POST", prepared.url, headers=prepared.headers, json=prepared.body
    )
    upstream = await client.send(outbound, stream=True)
    if (
        upstream.is_success
        and upstream.headers.get("content-type", "").split(";")[0].lower().strip()
        == "text/event-stream"
    ):
        return upstream
    try:
        if upstream.status_code == 400:
            body = bytearray()
            async for chunk in upstream.aiter_bytes():
                if len(body) + len(chunk) > 65536:
                    break
                body.extend(chunk)
            else:
                try:
                    detail = json.loads(body)
                    error = detail.get("error") if isinstance(detail, dict) else None
                    if isinstance(error, dict) and error.get("code") == "context_length_exceeded":
                        raise ModelDeskError(400, "context_length_exceeded", "请求超过模型上下文长度")
                except ValueError:
                    pass
            raise ModelDeskError(400, "invalid_request", "模型请求被上游拒绝")
        raise _upstream_error()
    finally:
        with CancelScope(shield=True):
            await upstream.aclose()


class UpstreamStream(StreamingResponse):
    def __init__(self, content, cleanup: Callable[[], Awaitable[None]]) -> None:
        super().__init__(
            content,
            media_type="text/event-stream",
            headers={**NO_STORE, "X-Accel-Buffering": "no"},
        )
        self.cleanup = cleanup

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with CancelScope(shield=True):
                await self.cleanup()


@router.post("/chat/completions")
async def chat_completions(
    request: Request,
    body: dict,
    auth: Annotated[Authenticated, Depends(require_access)],
):
    # Clients cannot reuse a request ID to evade metering.
    request.state.request_id = f"req_{secrets.token_hex(12)}"
    now = utcnow()
    call = Call(
        request.state.request_id,
        auth.user.id,
        auth.session.id,
        0,
        billing_month(now),
        time.monotonic(),
    )
    session_factory = request.app.state.session_factory
    client = request.app.state.upstream
    handed_off = False
    try:
        call.model_id = parse_model_ref(str(body.get("model", "")))
        payload = validate_chat_payload(body)
        adapter, prepared = await to_thread.run_sync(
            _prepare, call, auth, payload, session_factory, now
        )
        if payload.get("stream") is True:
            upstream = await _open(client, prepared)
            include_usage = (payload.get("stream_options") or {}).get("include_usage", False)

            async def cleanup() -> None:
                call.cancel()
                try:
                    await upstream.aclose()
                finally:
                    await call.finish(session_factory)

            response = UpstreamStream(
                _relay(request, upstream, adapter, call, include_usage), cleanup
            )
            handed_off = True
            return response
        async with asyncio.timeout(300):
            upstream = await _open(client, prepared)
            try:
                completion = Completion()
                raw_usage = None
                async for _, data in frames(upstream):
                    if data == "[DONE]":
                        break
                    if isinstance(data, dict):
                        usage = adapter.normalize_usage(data)
                        if usage is not None:
                            call.usage = usage
                            raw_usage = data["usage"]
                        completion.add(data)
                return JSONResponse(completion.payload(raw_usage), headers=NO_STORE)
            finally:
                with CancelScope(shield=True):
                    await upstream.aclose()
    except asyncio.CancelledError:
        call.cancel()
        raise
    except (httpx.TimeoutException, TimeoutError) as exc:
        error = _timeout()
        call.fail(error)
        raise error from exc
    except (httpx.HTTPError, TypeError, KeyError, AttributeError, ValueError) as exc:
        error = _upstream_error()
        call.fail(error)
        raise error from exc
    except ModelDeskError as exc:
        call.fail(exc)
        raise
    finally:
        if not handed_off:
            with CancelScope(shield=True):
                await call.finish(session_factory)


async def _relay(request, upstream, adapter, call, include_usage):
    finished = False
    try:
        async for raw, data in frames(upstream):
            if data == "[DONE]":
                if not finished:
                    break
                call.stream_complete = True
                yield raw
                return
            if isinstance(data, dict):
                call.usage = adapter.normalize_usage(data) or call.usage
                choices = data.get("choices")
                if isinstance(choices, list) and any(
                    isinstance(choice, dict) and choice.get("finish_reason") is not None
                    for choice in choices
                ):
                    finished = True
                if "usage" in data and not include_usage:
                    if not data.get("choices"):
                        continue
                    data = {key: value for key, value in data.items() if key != "usage"}
                    raw = f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
            if raw:
                yield raw
        call.status = "UPSTREAM_INCOMPLETE"
        call.http_status = 502
        error = ModelDeskError(502, "upstream_incomplete", "上游模型服务返回了不完整的响应")
        body = error_body(request, error.code, error.message, error.type)
        yield f"data: {json.dumps(body, ensure_ascii=False)}\n\n"
    except (httpx.HTTPError, ModelDeskError) as exc:
        if isinstance(exc, httpx.TimeoutException):
            error = _timeout()
        else:
            error = _upstream_error()
        call.fail(error)
        body = error_body(request, error.code, error.message, error.type)
        yield f"data: {json.dumps(body, ensure_ascii=False)}\n\n"
