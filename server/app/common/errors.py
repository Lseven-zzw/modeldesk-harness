from fastapi import Request
from fastapi.responses import JSONResponse

from app.common.request_id import current_request_id

# 规格 §6.3：type 固定六值
ERROR_TYPES: dict[str, tuple[int, str]] = {
    "invalid_request": (400, "invalid_request_error"),
    "unsupported_parameter": (400, "invalid_request_error"),
    "context_length_exceeded": (400, "invalid_request_error"),
    "invalid_grant": (400, "invalid_request_error"),
    "pkce_verification_failed": (400, "invalid_request_error"),
    "invalid_access_token": (401, "authentication_error"),
    "invalid_refresh_token": (401, "authentication_error"),
    "refresh_token_reused": (401, "authentication_error"),
    "session_expired": (401, "authentication_error"),
    "session_revoked": (401, "authentication_error"),
    "permission_denied": (403, "permission_error"),
    "model_not_allowed": (403, "permission_error"),
    "user_disabled": (403, "permission_error"),
    "monthly_token_limit_exceeded": (429, "quota_error"),
    "upstream_error": (502, "upstream_error"),
    "upstream_incomplete": (502, "upstream_error"),
    "upstream_timeout": (504, "upstream_error"),
    "authorization_unavailable": (503, "server_error"),
    "quota_unavailable": (503, "server_error"),
    "internal_error": (500, "server_error"),
}


class ModelDeskError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    @property
    def type(self) -> str:
        return ERROR_TYPES.get(self.code, (self.status, "server_error"))[1]


def error_body(request: Request, code: str, message: str, type_: str) -> dict:
    return {
        "error": {"message": message, "type": type_, "code": code},
        "request_id": current_request_id(request),
    }


def error_response(request: Request, exc: ModelDeskError) -> JSONResponse:
    return JSONResponse(
        error_body(request, exc.code, exc.message, exc.type),
        status_code=exc.status,
        headers={"Cache-Control": "no-store", "X-Request-ID": current_request_id(request)},
    )


async def modeldesk_error_handler(request: Request, exc: ModelDeskError) -> JSONResponse:
    return error_response(request, exc)


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(
        error_body(request, "internal_error", "服务内部错误", "server_error"),
        status_code=500,
        headers={"Cache-Control": "no-store", "X-Request-ID": current_request_id(request)},
    )
