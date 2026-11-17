from fastapi.testclient import TestClient

from app.auth.admin_session import require_browser_user, require_csrf
from app.common.clock import utcnow
from app.db import get_session
from app.main import create_app
from app.models import CreditRule, ModelCall, MonthlyUsage, User


def make_client(db, admin):
    app = create_app()

    def admin_override() -> User:
        return admin

    app.dependency_overrides[get_session] = lambda: db
    app.dependency_overrides[require_browser_user] = admin_override
    app.dependency_overrides[require_csrf] = lambda: None
    return TestClient(app)


def seed(db):
    admin = User(
        username="admin",
        password_hash="x",
        display_name="管理员",
        department=None,
        role="ADMIN",
        status=1,
        created_at=utcnow(),
    )
    employee = User(
        username="zhang.san",
        password_hash="x",
        display_name="张三",
        department="剪辑部",
        role="EMPLOYEE",
        status=1,
        created_at=utcnow(),
    )
    db.add_all([admin, employee])
    db.commit()
    db.add_all(
        [
            ModelCall(
                request_id="req_1",
                user_id=employee.id,
                session_id="gsess_1",
                model_id=1,
                model_code="qwen-max",
                billing_month="2026-11",
                input_tokens=100,
                output_tokens=50,
                cached_tokens=None,
                total_tokens=150,
                status="SUCCESS",
                http_status=200,
                latency_ms=900,
                created_at=utcnow(),
            ),
            ModelCall(
                request_id="req_2",
                user_id=employee.id,
                session_id="gsess_1",
                model_id=1,
                model_code="qwen-max",
                billing_month="2026-11",
                input_tokens=None,
                output_tokens=None,
                cached_tokens=None,
                total_tokens=None,
                status="UPSTREAM_ERROR",
                http_status=502,
                latency_ms=120,
                created_at=utcnow(),
            ),
            ModelCall(
                request_id="req_3",
                user_id=employee.id,
                session_id="gsess_1",
                model_id=1,
                model_code="qwen-max",
                billing_month="2026-10",
                input_tokens=10,
                output_tokens=10,
                cached_tokens=None,
                total_tokens=20,
                status="SUCCESS",
                http_status=200,
                latency_ms=100,
                created_at=utcnow(),
            ),
        ]
    )
    db.add(
        MonthlyUsage(
            user_id=employee.id, billing_month="2026-11", used_tokens=150, updated_at=utcnow()
        )
    )
    db.commit()
    return admin, employee


def test_calls_filter_by_month_and_expose_display_name(db):
    admin, _employee = seed(db)
    client = make_client(db, admin)
    response = client.get("/api/admin/usage/calls", params={"month": "2026-11"})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert all(item["display_name"] == "张三" for item in body["items"])
    assert {item["request_id"] for item in body["items"]} == {"req_1", "req_2"}


def test_summary_keeps_unknown_usage_visible_without_adding_zero(db):
    admin, employee = seed(db)
    client = make_client(db, admin)
    response = client.get("/api/admin/usage/summary", params={"month": "2026-11"})
    assert response.status_code == 200
    row = next(item for item in response.json()["items"] if item["user_id"] == employee.id)
    assert row["used_tokens"] == 150
    assert row["limit_tokens"] == 10_000_000
    assert row["call_count"] == 2
    assert row["unknown_usage_calls"] == 1


def test_summary_paginates_without_changing_totals_or_counting_rejections(db):
    admin, employee = seed(db)
    db.add(ModelCall(
        request_id="req_rejected", user_id=admin.id, session_id="gsess_2",
        model_id=1, model_code="qwen-max", billing_month="2026-11",
        status="BLOCKED_QUOTA", http_status=429, latency_ms=1, created_at=utcnow(),
    ))
    db.add(CreditRule(subject_type="USER", subject_id=str(employee.id), model_id=0,
                      monthly_token_limit=500, created_at=utcnow()))
    db.commit()
    client = make_client(db, admin)
    params = {"month": "2026-11", "page_size": 1}
    first = client.get("/api/admin/usage/summary", params=params).json()
    second = client.get("/api/admin/usage/summary", params={**params, "page": 2}).json()
    assert [item["user_id"] for item in first["items"]] == [employee.id]
    assert first["items"][0]["limit_tokens"] == 500
    assert [item["user_id"] for item in second["items"]] == [admin.id]
    assert second["items"][0]["unknown_usage_calls"] == 0
    assert first["totals"] == second["totals"] == {"people": 2, "used": 150, "unknown": 1}
    options = client.get("/api/admin/usage/employees", params={"month": "2026-11", "q": "张"}).json()
    assert options["items"] == [{"user_id": employee.id, "display_name": "张三"}]
