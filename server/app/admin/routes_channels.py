import json
import re
from typing import Annotated

import httpx
from anyio import fail_after
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.admin.rbac import Access, effective_permissions, forbidden
from app.admin.routes_models import _base, _commit_unique, _encrypt, _hint, _kind, _no_store, _required, _view
from app.auth.admin_session import require_browser_user, require_csrf, require_permission
from app.common.clock import utcnow
from app.common.crypto import SecretBox
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import ModelChannel, ModelRow, User
from app.settings import get_settings

router = APIRouter(prefix="/api/admin/channels", tags=["admin"], dependencies=[Depends(_no_store)])
ChannelCreateAccess = Annotated[Access, Depends(require_permission("models.create"))]
ChannelUpdate = Annotated[Access, Depends(require_permission("models.update"))]
CSRF = Annotated[None, Depends(require_csrf)]
Database = Annotated[Session, Depends(get_session)]
Name = Annotated[str, Field(min_length=1, max_length=100)]
ModelID = Annotated[str, Field(min_length=1, max_length=200)]


class ChannelCreate(BaseModel):
    name: Name
    upstream_base: str
    api_key: str


class ChannelPatch(BaseModel):
    name: Name
    upstream_base: str
    api_key: str | None = None


class ModelImport(BaseModel):
    models: list[ModelID] = Field(min_length=1, max_length=100)


def _channel(db: Session, channel_id: int, *, lock: bool = False) -> ModelChannel:
    row = db.get(ModelChannel, channel_id, with_for_update=lock) if 0 < channel_id < 2**63 else None
    if row is None:
        raise ModelDeskError(404, "invalid_request", "渠道不存在")
    return row


def _channel_view(row: ModelChannel) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "upstream_kind": row.upstream_kind,
        "upstream_base": row.upstream_base,
        "api_key_masked": f"••••{row.key_hint}",
    }


@router.get("")
def list_channels(user: Annotated[User, Depends(require_browser_user)], db: Database) -> dict:
    if not effective_permissions(db, user).keys() & {"models.create", "models.update"}:
        raise forbidden()
    return {"items": [_channel_view(row) for row in db.scalars(select(ModelChannel).order_by(ModelChannel.id))]}


@router.post("", status_code=201)
def create_channel(body: ChannelCreate, _access: ChannelCreateAccess, _csrf: CSRF, db: Database) -> dict:
    row = ModelChannel(
        name=_required(body.name),
        upstream_base=_base(body.upstream_base),
        upstream_kind=_kind("openai"),
        api_key_cipher=_encrypt(body.api_key),
        key_hint=_hint(body.api_key.strip()),
    )
    db.add(row)
    db.commit()
    return _channel_view(row)


@router.patch("/{channel_id}")
def patch_channel(channel_id: int, body: ChannelPatch, _access: ChannelUpdate, _csrf: CSRF, db: Database) -> dict:
    row = _channel(db, channel_id, lock=True)
    upstream_base = _base(body.upstream_base)
    if upstream_base != row.upstream_base and body.api_key is None:
        raise ModelDeskError(400, "invalid_request", "更换上游地址时请重新填写 API Key")
    row.name = _required(body.name)
    row.upstream_base = upstream_base
    if body.api_key is not None:
        row.api_key_cipher = _encrypt(body.api_key)
        row.key_hint = _hint(body.api_key.strip())
    db.commit()
    return _channel_view(row)


def _connection(channel_id: int, _access: ChannelCreateAccess, _csrf: CSRF, db: Database) -> tuple[str, str]:
    row = _channel(db, channel_id)
    return row.upstream_base, SecretBox(get_settings().master_key).decrypt(row.api_key_cipher)


@router.post("/{channel_id}/discover")
async def discover_models(
    request: Request, connection: Annotated[tuple[str, str], Depends(_connection)]
) -> dict:
    base, key = connection
    try:
        with fail_after(10):
            async with request.app.state.upstream.stream(
                "GET", base + "/models", headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}
            ) as response:
                if response.status_code in (401, 403):
                    raise ModelDeskError(422, "invalid_request", "上游拒绝了请求，请检查 API Key 和访问权限")
                if response.status_code in (404, 405):
                    return {"supported": False, "items": []}
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes(chunk_size=16384):
                    if len(data) + len(chunk) > 2_097_152:
                        raise ModelDeskError(502, "upstream_error", "上游模型列表太大，请手动填写模型 ID")
                    data.extend(chunk)
                payload = json.loads(data)
    except (TimeoutError, httpx.TimeoutException) as exc:
        raise ModelDeskError(504, "upstream_timeout", "连接上游超时，请检查渠道地址") from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise ModelDeskError(502, "upstream_error", "无法读取上游模型列表，请检查渠道地址或手动填写模型 ID") from exc
    entries = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        return {"supported": False, "items": []}
    models = {
        item["id"].strip()
        for item in entries
        if isinstance(item, dict) and isinstance(item.get("id"), str) and 0 < len(item["id"].strip()) <= 200
    }
    return {"supported": True, "items": sorted(models)}


@router.post("/{channel_id}/models", status_code=201)
def import_models(channel_id: int, body: ModelImport, _access: ChannelCreateAccess, _csrf: CSRF, db: Database) -> dict:
    channel = _channel(db, channel_id, lock=True)
    existing = set(db.scalars(
        select(ModelRow.upstream_model).where(ModelRow.channel_id == channel.id).with_for_update()
    ))
    used_codes = set(db.scalars(select(ModelRow.code)))
    created = []
    skipped = []
    for upstream_model in dict.fromkeys(_required(value) for value in body.models):
        if upstream_model in existing:
            skipped.append(upstream_model)
            continue
        prefix = re.sub(r"[^a-z0-9._-]+", "-", upstream_model.lower()).strip("-._") or "model"
        code = prefix[:64]
        suffix = 1
        while code in used_codes:
            ending = f"-{channel.id}-{suffix}"
            code = prefix[:64 - len(ending)] + ending
            suffix += 1
        used_codes.add(code)
        row = ModelRow(
            code=code,
            display_name=upstream_model,
            upstream_model=upstream_model,
            channel=channel,
            upstream_base="",
            upstream_kind=channel.upstream_kind,
            api_key_cipher=b"",
            capabilities="streaming",
            enabled=1,
            created_at=utcnow(),
        )
        db.add(row)
        created.append(row)
    _commit_unique(db, "模型编码已存在，请重试")
    return {"items": [_view(row) for row in created], "skipped": skipped}
