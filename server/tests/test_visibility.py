from app.common.clock import utcnow
from app.common.errors import ModelDeskError
from app.model.visibility import parse_model_ref, require_model_visible, visible_models
from app.models import ModelGrant, ModelRow, User


def model(db, pid, enabled=1):
    row = ModelRow(
        id=pid,
        code=f"m{pid}",
        display_name=f"模型{pid}",
        provider_name="测试",
        upstream_kind="openai",
        upstream_model="gpt-4o-mini",
        upstream_base="https://api.example.com/v1",
        api_key_cipher=b"x",
        extra_config=None,
        capabilities="streaming,tools",
        enabled=enabled,
        created_at=utcnow(),
    )
    db.add(row)
    db.commit()
    return row


def user(db, department="剪辑部", role="EMPLOYEE"):
    row = User(
        username=f"u{department or 'x'}{role}",
        password_hash="x",
        display_name="张三",
        department=department,
        role=role,
        status=1,
        created_at=utcnow(),
    )
    db.add(row)
    db.commit()
    return row


def test_parse_model_ref():
    assert parse_model_ref("modeldesk:7") == 7


def test_parse_model_ref_rejects_foreign_prefix():
    try:
        parse_model_ref("bisheng:7")
    except ModelDeskError as exc:
        assert exc.code == "invalid_request"
    else:
        raise AssertionError("expected ModelDeskError")


def test_everyone_department_user_grants(db):
    for model_id in range(1, 5):
        model(db, model_id)
    u = user(db)
    db.add(ModelGrant(model_id=1, subject_type="EVERYONE", subject_id="*", created_at=utcnow()))
    db.add(
        ModelGrant(model_id=2, subject_type="DEPARTMENT", subject_id="剪辑部", created_at=utcnow())
    )
    db.add(ModelGrant(model_id=3, subject_type="USER", subject_id=str(u.id), created_at=utcnow()))
    db.commit()
    assert {m.id for m in visible_models(db, u)} == {1, 2, 3}
    try:
        require_model_visible(db, u, 4)
    except ModelDeskError as exc:
        assert exc.code == "model_not_allowed"
    else:
        raise AssertionError("expected model_not_allowed")


def test_admin_sees_all_enabled(db):
    model(db, 1, enabled=0)
    model(db, 2)
    assert {m.id for m in visible_models(db, user(db, role="ADMIN"))} == {2}
