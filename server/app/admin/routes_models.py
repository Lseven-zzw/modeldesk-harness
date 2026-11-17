import re
from typing import Annotated, Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.admin.authorization_audit import record_change
from app.admin.rbac import MODEL_OPERATIONS, PERMISSIONS, Access, effective_permissions, forbidden, model_permissions
from app.admin.routes_employees import StatusBody, _lock_active_admins
from app.auth.admin_session import require_admin, require_browser_user, require_csrf, require_model_permission, require_permission
from app.common.clock import utcnow
from app.common.crypto import SecretBox
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import CreditRule, Department, ModelAdminGrant, ModelGrant, ModelRow, User, UserGroup
from app.proxy.upstreams.registry import available_kinds
from app.settings import get_settings


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store"


router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(_no_store)])
CODE_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
CAPS = {"streaming", "tools", "reasoning_content"}
CAPS_CTX = re.compile(r"^ctx:[1-9][0-9]*$")


class ModelCreate(BaseModel):
    code: str
    display_name: str = Field(min_length=1, max_length=200)
    provider_name: str | None = Field(default=None, max_length=100)
    upstream_kind: str = "openai"
    upstream_model: str = Field(min_length=1, max_length=200)
    upstream_base: str
    api_key: str
    extra_config: dict | None = None
    capabilities: str = ""
    enabled: bool = True


class ModelPatch(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=200)
    provider_name: str | None = Field(default=None, max_length=100)
    upstream_kind: str | None = None
    upstream_model: str | None = Field(default=None, min_length=1, max_length=200)
    upstream_base: str | None = None
    api_key: str | None = None
    extra_config: dict | None = None
    capabilities: str | None = None


class GrantItem(BaseModel):
    subject_type: str
    subject_id: str = Field(min_length=1, max_length=64)


class GrantsBody(BaseModel):
    grants: list[GrantItem]


class CreditRuleBody(BaseModel):
    subject_type: str
    subject_id: str = Field(min_length=1, max_length=64)
    model_id: int = Field(default=0, ge=0, le=2**63 - 1)
    monthly_token_limit: int = Field(ge=0, le=2**63 - 1)


def _capabilities(value: str) -> str:
    parts = [part.strip() for part in value.split(",") if part.strip()]
    unknown = [part for part in parts if part not in CAPS and not CAPS_CTX.fullmatch(part)]
    if unknown:
        raise ModelDeskError(400, "invalid_request", f"未知能力标记：{', '.join(unknown)}")
    unique = list(dict.fromkeys(parts))
    result = ",".join(unique)
    if len(result) > 64 or sum(part.startswith("ctx:") for part in unique) > 1:
        raise ModelDeskError(400, "invalid_request", "能力标记过长或重复声明上下文窗口")
    return result


def _base(value: str) -> str:
    cleaned = value.strip().rstrip("/")
    try:
        parsed = urlparse(cleaned)
        port = parsed.port
    except ValueError as exc:
        raise ModelDeskError(400, "invalid_request", "上游地址不合法") from exc
    if (
        len(cleaned) > 255
        or parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or port == 0
        or any(c.isspace() for c in cleaned)
        or any(c in cleaned for c in "?#" + chr(92))
    ):
        raise ModelDeskError(
            400, "invalid_request", "上游地址必须是 http(s) 地址，且只包含主机、端口和路径"
        )
    return cleaned


def _required(value: str) -> str:
    if not value.strip():
        raise ModelDeskError(400, "invalid_request", "模型名称不能为空")
    return value.strip()


def _extra(value: dict | None) -> dict:
    result = dict(value or {})
    if any(
        key not in {"api_version", "region"} or not isinstance(item, str)
        for key, item in result.items()
    ):
        raise ModelDeskError(400, "invalid_request", "扩展配置仅支持 api_version 和 region 字符串")
    return result


def _commit_unique(db: Session, message: str) -> None:
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        if getattr(exc.orig, "sqlite_errorcode", None) == 2067 or exc.orig.args[:1] == (1062,):
            raise ModelDeskError(400, "invalid_request", message) from exc
        raise


def _employee_id(db: Session, value: str) -> str:
    if value.isascii() and value.isdecimal() and 0 < int(value) <= 2**63 - 1:
        row = db.get(User, int(value))
        if row is not None:
            return str(row.id)
    raise ModelDeskError(400, "invalid_request", "员工不存在")


def _department_id(db: Session, value: str) -> str:
    registered = db.scalar(select(Department).where(Department.code == value).with_for_update())
    if registered is not None:
        if registered.archived:
            raise ModelDeskError(400, "invalid_request", "部门已归档")
        return registered.code
    collation = "utf8mb4_bin" if db.get_bind().dialect.name == "mysql" else "BINARY"
    department = db.scalar(
        select(User.department).where(User.department.collate(collation) == value)
        .order_by(User.id).limit(1)
    )
    if not department:
        raise ModelDeskError(400, "invalid_request", "部门不存在")
    return department


def _kind(value: str) -> str:
    if value not in available_kinds():
        raise ModelDeskError(
            400,
            "unsupported_parameter",
            f"上游类型 {value} 尚未实现；可选：{', '.join(available_kinds())}",
        )
    return value


def _hint(api_key: str) -> str:
    return api_key[-4:] if len(api_key) >= 4 else "****"


def _encrypt(api_key: str) -> bytes:
    if len(api_key.strip()) < 8:
        raise ModelDeskError(400, "invalid_request", "上游密钥过短")
    if len(api_key.strip().encode()) > 484 or any(not 33 <= ord(c) <= 126 for c in api_key.strip()):
        raise ModelDeskError(400, "invalid_request", "上游密钥过长或包含非法字符")
    return SecretBox(get_settings().master_key).encrypt(api_key.strip())


def _view(row: ModelRow) -> dict:
    connection = row.channel or row
    extra = {
        key: value
        for key, value in (row.extra_config or {}).items()
        if key in {"api_version", "region"}
    }
    hint = row.channel.key_hint if row.channel else (row.extra_config or {}).get("key_hint")
    return {
        "id": row.id,
        "code": row.code,
        "display_name": row.display_name,
        "provider_name": row.channel.name if row.channel else row.provider_name,
        "channel_id": row.channel_id,
        "upstream_kind": connection.upstream_kind,
        "upstream_model": row.upstream_model,
        "upstream_base": connection.upstream_base,
        "api_key_masked": f"••••{hint}" if hint else "已配置",
        "extra_config": extra or None,
        "capabilities": row.capabilities,
        "enabled": bool(row.enabled),
        "created_at": row.created_at.isoformat(),
    }


def _get_model(db: Session, model_id: int, *, lock: bool = False) -> ModelRow:
    row = (
        db.get(ModelRow, model_id, with_for_update=lock, populate_existing=lock)
        if 0 < model_id <= 2**63 - 1
        else None
    )
    if row is None:
        raise ModelDeskError(404, "invalid_request", "模型不存在")
    return row


class DelegationSubject(BaseModel):
    subject_type: Literal["USER", "DEPARTMENT", "GROUP"]
    subject_id: int = Field(gt=0, le=2**63 - 1)

    def key(self) -> tuple[str, int]:
        return self.subject_type, self.subject_id


class ModelDelegation(DelegationSubject):
    permissions: set[str] = Field(min_length=1, max_length=len(MODEL_OPERATIONS))
    include_descendants: bool = False


class ModelDelegationChanges(BaseModel):
    revision: int = Field(ge=0, le=2**63 - 1)
    upsert: list[ModelDelegation] = Field(default_factory=list, max_length=500)
    remove: list[DelegationSubject] = Field(default_factory=list, max_length=500)


DelegationKey = tuple[str, int]
DelegationValue = tuple[tuple[str, ...], bool]


def _model_delegations(db: Session, model_id: int, *, lock: bool = False) -> dict[DelegationKey, DelegationValue]:
    statement = select(ModelAdminGrant).where(ModelAdminGrant.model_id == model_id).order_by(
        ModelAdminGrant.subject_type, ModelAdminGrant.subject_id, ModelAdminGrant.permission,
    )
    if lock:
        statement = statement.with_for_update()
    grants: dict[DelegationKey, list[ModelAdminGrant]] = {}
    for row in db.scalars(statement):
        grants.setdefault((row.subject_type, row.subject_id), []).append(row)
    return {key: (tuple(row.permission for row in rows), rows[0].include_descendants)
            for key, rows in grants.items()}


def _delegations_view(delegations: dict[DelegationKey, DelegationValue]) -> list[dict]:
    return [
        {"subject_type": kind, "subject_id": subject_id, "permissions": list(permissions),
         "include_descendants": include}
        for (kind, subject_id), (permissions, include) in sorted(delegations.items())
    ]


@router.get("/models/{model_id}/delegations")
def list_delegations(
    model_id: int, _root: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    model = _get_model(db, model_id)
    return {
        "revision": model.delegation_revision,
        "items": _delegations_view(_model_delegations(db, model_id)),
        "operations": [{"code": code, "name": PERMISSIONS[code]} for code in PERMISSIONS
                       if code in MODEL_OPERATIONS],
    }


def _check_subjects(db: Session, keys: set[DelegationKey], desired: dict[DelegationKey, DelegationValue]) -> None:
    for kind, table in (("USER", User), ("DEPARTMENT", Department), ("GROUP", UserGroup)):
        expected = {subject_id for subject_type, subject_id in keys if subject_type == kind}
        if not expected:
            continue
        query = select(table.id).where(table.id.in_(expected))
        if kind == "USER":
            query = query.where(User.role != "ADMIN")
        elif kind == "DEPARTMENT":
            query = query.where(Department.archived.is_(False))
        found = set(db.scalars(query.order_by(table.id).with_for_update()))
        if found != expected:
            raise ModelDeskError(400, "invalid_request", "授权对象不存在、已归档或已是超级管理员")
    for key in keys:
        permissions, include = desired[key]
        if not set(permissions) <= MODEL_OPERATIONS or (include and key[0] != "DEPARTMENT"):
            raise ModelDeskError(400, "invalid_request", "操作权限或下级部门范围无效")


@router.patch("/models/{model_id}/delegations", dependencies=[Depends(require_csrf)])
def update_delegations(
    model_id: int, body: ModelDelegationChanges, root: Annotated[User, Depends(require_admin)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    _lock_active_admins(db, root.id)
    model = _get_model(db, model_id, lock=True)
    if body.revision != model.delegation_revision:
        raise ModelDeskError(409, "revision_conflict", "授权已被其他管理员修改，请重新加载后再操作")
    before = _model_delegations(db, model_id, lock=True)
    upsert = {item.key(): (tuple(sorted(item.permissions)), item.include_descendants) for item in body.upsert}
    remove = {item.key() for item in body.remove}
    if len(upsert) != len(body.upsert) or len(remove) != len(body.remove) or remove & upsert.keys():
        raise ModelDeskError(400, "invalid_request", "同一授权对象不能重复修改")
    desired = {**{key: value for key, value in before.items() if key not in remove}, **upsert}
    if len(desired) > 500:
        raise ModelDeskError(400, "invalid_request", "一个模型最多支持 500 个委派对象")
    _check_subjects(db, {key for key in upsert if before.get(key) != upsert[key]}, desired)
    changed = {key for key in before.keys() | desired.keys() if before.get(key) != desired.get(key)}
    for kind, subject_id in sorted(changed):
        db.execute(delete(ModelAdminGrant).where(
            ModelAdminGrant.model_id == model_id,
            ModelAdminGrant.subject_type == kind, ModelAdminGrant.subject_id == subject_id,
        ))
        permissions, include = desired.get((kind, subject_id), ((), False))
        db.add_all(ModelAdminGrant(
            model_id=model_id, subject_type=kind, subject_id=subject_id, permission=permission,
            include_descendants=include,
        ) for permission in permissions)
    if changed:
        model.delegation_revision += 1
        record_change(db, root.id, "model.delegations", str(model_id),
                      _delegations_view({key: before[key] for key in changed if key in before}),
                      _delegations_view({key: desired[key] for key in changed if key in desired}))
    revision = model.delegation_revision
    db.commit()
    return {"items": _delegations_view(desired), "revision": revision}


@router.get("/models")
def list_models(
    user: Annotated[User, Depends(require_browser_user)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    statement = select(ModelRow).order_by(ModelRow.id)
    if "models.read" not in effective_permissions(db, user):
        allowed = [model_id for model_id, ops in model_permissions(db, user).items() if "models.read" in ops]
        if not allowed:
            raise forbidden()
        statement = statement.where(ModelRow.id.in_(allowed))
    rows = db.scalars(statement).all()
    return {"items": [_view(row) for row in rows], "upstream_kinds": available_kinds()}


@router.post("/models", status_code=201)
def create_model(
    body: ModelCreate,
    _access: Annotated[Access, Depends(require_permission("models.create"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    if not CODE_RE.fullmatch(body.code):
        raise ModelDeskError(
            400, "invalid_request", "模型编码只能是小写字母、数字、点、下划线或连字符"
        )
    if db.scalar(select(ModelRow.id).where(ModelRow.code == body.code)) is not None:
        raise ModelDeskError(400, "invalid_request", "模型编码已存在")
    extra = _extra(body.extra_config)
    extra["key_hint"] = _hint(body.api_key.strip())
    row = ModelRow(
        code=body.code,
        display_name=_required(body.display_name),
        provider_name=body.provider_name,
        upstream_kind=_kind(body.upstream_kind),
        upstream_model=_required(body.upstream_model),
        upstream_base=_base(body.upstream_base),
        api_key_cipher=_encrypt(body.api_key),
        extra_config=extra,
        capabilities=_capabilities(body.capabilities),
        enabled=int(body.enabled),
        created_at=utcnow(),
    )
    db.add(row)
    _commit_unique(db, "模型编码已存在")
    return _view(row)


@router.patch("/models/{model_id}")
def patch_model(
    model_id: int,
    body: ModelPatch,
    access: Annotated[Access, Depends(require_model_permission("models.update"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    row = _get_model(db, model_id, lock=True)
    if row.channel_id is not None and body.model_fields_set.intersection(
        {"provider_name", "upstream_kind", "upstream_base", "api_key"}
    ):
        raise ModelDeskError(400, "invalid_request", "请在渠道管理中修改连接配置")
    if body.display_name is not None:
        row.display_name = _required(body.display_name)
    if "provider_name" in body.model_fields_set:
        row.provider_name = body.provider_name
    if body.upstream_kind is not None:
        row.upstream_kind = _kind(body.upstream_kind)
    if body.upstream_model is not None:
        row.upstream_model = _required(body.upstream_model)
    if body.upstream_base is not None:
        upstream_base = _base(body.upstream_base)
        if (
            upstream_base != row.upstream_base
            and access.user.role != "ADMIN"
            and body.api_key is None
        ):
            raise ModelDeskError(400, "invalid_request", "更换上游地址时必须提供新的 API Key")
        row.upstream_base = upstream_base
    if body.capabilities is not None:
        row.capabilities = _capabilities(body.capabilities)
    if "extra_config" in body.model_fields_set:
        extra = _extra(body.extra_config)
        extra["key_hint"] = (row.extra_config or {}).get("key_hint", "****")
        row.extra_config = extra
    if body.api_key is not None:
        row.api_key_cipher = _encrypt(body.api_key)
        extra = dict(row.extra_config or {})
        extra["key_hint"] = _hint(body.api_key.strip())
        row.extra_config = extra
    db.commit()
    return _view(row)


@router.post("/models/{model_id}/status")
def set_model_status(
    model_id: int,
    body: StatusBody,
    _access: Annotated[Access, Depends(require_model_permission("models.status"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    row = _get_model(db, model_id, lock=True)
    row.enabled = body.status
    db.commit()
    return _view(row)


@router.get("/models/{model_id}/grants")
def list_grants(
    model_id: int,
    _access: Annotated[Access, Depends(require_model_permission("grants.read"))],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    _get_model(db, model_id)
    rows = db.scalars(
        select(ModelGrant).where(ModelGrant.model_id == model_id).order_by(ModelGrant.id)
    ).all()
    return {
        "model_id": model_id,
        "grants": [
            {"subject_type": row.subject_type, "subject_id": row.subject_id} for row in rows
        ],
    }


@router.put("/models/{model_id}/grants")
def replace_grants(
    model_id: int,
    body: GrantsBody,
    access: Annotated[Access, Depends(require_model_permission("grants.write"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    _get_model(db, model_id, lock=True)
    seen: set[tuple[str, str]] = set()
    rows: list[ModelGrant] = []
    for item in body.grants:
        subject_type, subject_id = item.subject_type, item.subject_id
        if subject_type == "EVERYONE":
            if subject_id != "*":
                raise ModelDeskError(400, "invalid_request", "全员授权的 subject_id 必须是 *")
        elif subject_type == "DEPARTMENT":
            subject_id = _department_id(db, subject_id)
        elif subject_type == "USER":
            subject_id = _employee_id(db, subject_id)
        else:
            raise ModelDeskError(
                400, "invalid_request", "subject_type 只能是 EVERYONE/DEPARTMENT/USER"
            )
        key = (subject_type, subject_id)
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            ModelGrant(
                model_id=model_id,
                subject_type=subject_type,
                subject_id=subject_id,
                created_at=utcnow(),
            )
        )
    before = sorted(tuple(row) for row in db.execute(
        select(ModelGrant.subject_type, ModelGrant.subject_id).where(ModelGrant.model_id == model_id)
    ))
    record_change(db, access.user.id, "model.grants", str(model_id), before, sorted(seen))
    db.execute(delete(ModelGrant).where(ModelGrant.model_id == model_id))
    db.add_all(rows)
    db.commit()
    return {
        "model_id": model_id,
        "grants": [{"subject_type": key[0], "subject_id": key[1]} for key in sorted(seen)],
    }


@router.get("/credit-rules")
def list_credit_rules(
    _access: Annotated[Access, Depends(require_permission("credits.read"))],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    rows = db.scalars(select(CreditRule).order_by(CreditRule.id)).all()
    return {
        "items": [
            {
                "id": row.id,
                "subject_type": row.subject_type,
                "subject_id": row.subject_id,
                "model_id": row.model_id,
                "monthly_token_limit": row.monthly_token_limit,
            }
            for row in rows
        ]
    }


@router.post("/credit-rules", status_code=201)
def create_credit_rule(
    body: CreditRuleBody,
    access: Annotated[Access, Depends(require_permission("credits.create"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> dict:
    subject_id = body.subject_id
    if body.subject_type == "DEFAULT":
        if body.subject_id != "*":
            raise ModelDeskError(400, "invalid_request", "默认规则的 subject_id 必须是 *")
    elif body.subject_type == "USER":
        subject_id = _employee_id(db, subject_id)
    elif body.subject_type == "DEPARTMENT":
        subject_id = _department_id(db, subject_id)
    else:
        raise ModelDeskError(400, "invalid_request", "subject_type 只能是 USER/DEPARTMENT/DEFAULT")
    if body.model_id != 0 and db.get(ModelRow, body.model_id) is None:
        raise ModelDeskError(400, "invalid_request", "模型不存在")
    exists = db.scalar(
        select(CreditRule.id).where(
            CreditRule.subject_type == body.subject_type,
            CreditRule.subject_id == subject_id,
            CreditRule.model_id == body.model_id,
        )
    )
    if exists is not None:
        raise ModelDeskError(400, "invalid_request", "该主体在该模型上的额度规则已存在")
    row = CreditRule(
        subject_type=body.subject_type,
        subject_id=subject_id,
        model_id=body.model_id,
        monthly_token_limit=body.monthly_token_limit,
        created_at=utcnow(),
    )
    db.add(row)
    record_change(db, access.user.id, "credit.create", str(row.model_id), None, {
        "subject_type": row.subject_type, "subject_id": row.subject_id,
        "model_id": row.model_id, "monthly_token_limit": row.monthly_token_limit,
    })
    _commit_unique(db, "该主体在该模型上的额度规则已存在")
    return {
        "id": row.id,
        "subject_type": row.subject_type,
        "subject_id": row.subject_id,
        "model_id": row.model_id,
        "monthly_token_limit": row.monthly_token_limit,
    }


@router.delete("/credit-rules/{rule_id}", status_code=204)
def delete_credit_rule(
    rule_id: int,
    access: Annotated[Access, Depends(require_permission("credits.delete"))],
    _csrf: Annotated[None, Depends(require_csrf)],
    db: Annotated[Session, Depends(get_session)],
) -> Response:
    row = db.get(CreditRule, rule_id, with_for_update=True) if 0 < rule_id <= 2**63 - 1 else None
    if row is None:
        raise ModelDeskError(404, "invalid_request", "规则不存在")
    record_change(db, access.user.id, "credit.delete", str(row.model_id), {
        "subject_type": row.subject_type, "subject_id": row.subject_id,
        "model_id": row.model_id, "monthly_token_limit": row.monthly_token_limit,
    }, None)
    db.delete(row)
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})
