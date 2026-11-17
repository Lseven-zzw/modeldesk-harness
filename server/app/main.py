from contextlib import asynccontextmanager

import httpx
from anyio import create_task_group
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.middleware.sessions import SessionMiddleware

from app.admin.routes_channels import router as admin_channels_router
from app.admin.routes_departments import router as departments_router
from app.admin.routes_documents import admin_router as admin_documents_router
from app.admin.routes_documents import client_router as client_documents_router
from app.admin.routes_employees import router as employees_router
from app.admin.routes_groups import router as admin_groups_router
from app.admin.routes_mcp import admin_router as admin_mcp_router
from app.admin.routes_mcp import client_router as client_mcp_router
from app.admin.routes_models import router as admin_models_router
from app.admin.routes_rbac import router as admin_rbac_router
from app.admin.routes_skills import admin_router as admin_skills_router
from app.admin.routes_skills import client_router as client_skills_router
from app.admin.routes_usage import router as admin_usage_router
from app.admin.spa import mount_admin_ui
from app.auth import browser, routes
from app.common.errors import ModelDeskError, error_body, modeldesk_error_handler, unhandled_error_handler
from app.common.request_id import RequestIDMiddleware
from app.db import SessionLocal
from app.document_jobs import process_document_queue
from app.model.routes import router as model_router
from app.proxy.client import create_upstream_client
from app.proxy.routes import router as proxy_router
from app.settings import get_settings
from app.usage.routes import router as usage_router


def create_app(
    *, upstream_transport: httpx.AsyncBaseTransport | None = None, session_factory=SessionLocal
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        async with create_upstream_client(get_settings(), upstream_transport) as client:
            application.state.upstream = client
            application.state.session_factory = session_factory
            async with create_task_group() as workers:
                workers.start_soon(process_document_queue, session_factory)
                try:
                    yield
                finally:
                    workers.cancel_scope.cancel()

    settings = get_settings()
    app = FastAPI(
        title="modeldesk-server", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan
    )
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.secret_key,
        session_cookie="modeldesk_admin",
        max_age=8 * 3600,
        same_site="lax",
        https_only=settings.base_url.startswith("https://"),
    )
    app.add_middleware(RequestIDMiddleware)
    app.add_exception_handler(ModelDeskError, modeldesk_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.include_router(routes.router)
    app.include_router(browser.router)
    app.include_router(proxy_router)
    app.include_router(model_router)
    app.include_router(usage_router)
    app.include_router(employees_router)
    app.include_router(departments_router)
    app.include_router(admin_groups_router)
    app.include_router(admin_models_router)
    app.include_router(admin_channels_router)
    app.include_router(admin_usage_router)
    app.include_router(admin_rbac_router)
    app.include_router(admin_skills_router)
    app.include_router(client_skills_router)
    app.include_router(admin_documents_router)
    app.include_router(client_documents_router)
    app.include_router(admin_mcp_router)
    app.include_router(client_mcp_router)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            error_body(request, "invalid_request", "请求参数不合法", "invalid_request_error"),
            status_code=400,
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    mount_admin_ui(app)
    return app


app = create_app()
