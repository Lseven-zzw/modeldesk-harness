import re
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

_VALID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class RequestIDMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        inbound = request.headers.get("x-request-id")
        request.state.request_id = (
            inbound if inbound and _VALID.fullmatch(inbound) else f"req_{secrets.token_hex(12)}"
        )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response


def current_request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "req_unknown")
