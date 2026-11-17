import base64
from typing import Annotated, Literal
from urllib.parse import quote
from uuid import uuid4

import yaml
from fastapi import APIRouter, Depends, Path, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, delete, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.admin.authorization_audit import record_change
from app.admin.rbac import Access, effective_permissions, forbidden
from app.admin.resource_audience import ResourceAudience as SkillAudience
from app.admin.resource_audience import audience_options, validate_audience, visible_to
from app.admin.routes_employees import _no_store
from app.admin.skill_import import (
    ARCHIVE_LIMIT, ATTACHMENT_LIMIT, DESCRIPTION_LIMIT, INSTRUCTIONS_LIMIT, SKILL_FILE_LIMIT,
    download_github, invalid, parse_skill, parse_zip, safe_parts,
)
from app.auth.admin_session import require_admin_portal, require_csrf, require_permission
from app.auth.deps import require_access
from app.auth.service import Authenticated
from app.common.clock import utcnow
from app.common.errors import ModelDeskError
from app.db import get_session
from app.models import (
    EnterpriseSkill, EnterpriseSkillDraft, EnterpriseSkillGrant, EnterpriseSkillVersion, User,
)

admin_router = APIRouter(prefix="/api/admin/skills", dependencies=[Depends(_no_store)])
client_router = APIRouter(prefix="/api/v1/modeldesk")
DB = Annotated[Session, Depends(get_session)]
Reader = Annotated[Access, Depends(require_permission("skills.read"))]
Editor = Annotated[Access, Depends(require_permission("skills.edit"))]
Publisher = Annotated[Access, Depends(require_permission("skills.publish"))]
SkillCode = Annotated[str, Path(pattern=r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$", max_length=64)]


SkillCategory = Literal[
    "productivity", "content", "data-analysis", "business", "collaboration",
    "knowledge", "development", "finance", "lifestyle",
]


class SkillPublication(BaseModel):
    revision: int = Field(ge=0, lt=2**31 - 1)
    description: str = Field(min_length=1, max_length=DESCRIPTION_LIMIT)
    remarks: str | None = Field(default=None, max_length=1000)
    category: SkillCategory | None = None
    instructions: str = Field(min_length=1, max_length=INSTRUCTIONS_LIMIT)
    enabled: bool = True
    grants: list[SkillAudience] = Field(max_length=500)


def _current_versions():
    return select(EnterpriseSkill, EnterpriseSkillVersion).join(
        EnterpriseSkillVersion, and_(
            EnterpriseSkillVersion.code == EnterpriseSkill.code,
            EnterpriseSkillVersion.revision == EnterpriseSkill.revision,
        ),
    )


def _draft_view(draft: EnterpriseSkillDraft | None) -> dict | None:
    if draft is None:
        return None
    return {"revision": draft.revision, "description": draft.description, "instructions": draft.instructions,
            "remarks": draft.remarks, "category": draft.category,
            "enabled": draft.enabled, "grants": draft.grants, "updated_by": draft.updated_by,
            "updated_at": draft.updated_at.isoformat() + "Z", **_bundle_view(draft.bundle)}


def _bundle_view(bundle: dict | None) -> dict:
    return {"files": (bundle or {}).get("files", []),
            "source": (bundle or {}).get("source")}


def _version_view(version: EnterpriseSkillVersion) -> dict:
    return {"revision": version.revision, "description": version.description, "instructions": version.instructions,
            "remarks": version.remarks, "category": version.category,
            "published_by": version.published_by, "published_at": version.created_at.isoformat() + "Z",
            **_bundle_view(version.bundle)}


def _view(
    skill: EnterpriseSkill, version: EnterpriseSkillVersion, grants: list[dict],
    draft: EnterpriseSkillDraft | None = None,
) -> dict:
    return {"code": skill.code, **_version_view(version), "enabled": skill.enabled,
            "grants": grants, "draft": _draft_view(draft)}


def _draft_only(draft: EnterpriseSkillDraft) -> dict:
    return {"code": draft.code, "revision": 0, "enabled": False, "description": draft.description,
            "instructions": "", "remarks": None, "category": draft.category, "grants": [], "published_by": None, "published_at": None,
            "draft": _draft_view(draft), **_bundle_view(None)}


def _audience_view(grants) -> list[dict]:
    return [{"subject_type": kind, "subject_id": subject_id} for kind, subject_id in sorted(grants)]


def _lock_catalog(db: Session) -> None:
    # Shares the authorization write lock with role changes and group or department mutations.
    list(db.scalars(select(User.id).where(User.role == "ADMIN", User.status == 1)
                    .order_by(User.id).with_for_update()))


def _check_new_code(db: Session, code: str) -> None:
    published = set(db.scalars(select(EnterpriseSkill.code).with_for_update()))
    drafts = set(db.scalars(select(EnterpriseSkillDraft.code).with_for_update()))
    if code not in published | drafts and len(published | drafts) >= 100:
        raise ModelDeskError(409, "skill_limit", "企业技能库最多支持 100 个技能")


def _validated_contents(db: Session, description: str, instructions: str, audience: list[SkillAudience]):
    description, instructions = description.strip(), instructions.strip()
    if not description or not instructions:
        raise ModelDeskError(400, "invalid_request", "技能描述和指令不能为空")
    if len(instructions.encode("utf-8")) > INSTRUCTIONS_LIMIT:
        raise ModelDeskError(400, "invalid_request", "技能正文不能超过 48,000 字节")
    return description, instructions, validate_audience(db, audience)


def _grants(db: Session, code: str) -> list[tuple[str, int]]:
    return [tuple(row) for row in db.execute(
        select(EnterpriseSkillGrant.subject_type, EnterpriseSkillGrant.subject_id)
        .where(EnterpriseSkillGrant.code == code).with_for_update()
    )]


def _version_check(expected: int, row: EnterpriseSkill | None) -> None:
    if expected != (row.revision if row is not None else 0):
        raise ModelDeskError(409, "revision_conflict", "技能或草稿已更新，请重新加载")


def _draft_check(expected: str | None, draft: EnterpriseSkillDraft | None) -> None:
    if expected != (draft.revision if draft is not None else None):
        raise ModelDeskError(409, "revision_conflict", "技能草稿已更新，请重新加载")


def _publish(
    db: Session, code: str, skill: EnterpriseSkill | None, actor_id: int, description: str,
    instructions: str, enabled: bool, grants: set[tuple[str, int]],
    draft: EnterpriseSkillDraft | None = None, *, action: str = "skill.publish",
    bundle: dict | None = None, asset_data: list[dict] | None = None, remarks: str | None = None,
    category: str | None = None,
) -> dict:
    previous = None
    if skill is None:
        _check_new_code(db, code)
        skill = EnterpriseSkill(code=code, revision=1, enabled=enabled)
        db.add(skill)
        db.flush()
    else:
        previous = {"revision": skill.revision, "enabled": skill.enabled,
                    "grants": _audience_view(_grants(db, code))}
        skill.revision += 1
        skill.enabled = enabled
    version = EnterpriseSkillVersion(code=code, revision=skill.revision, description=description,
                                     instructions=instructions, created_at=utcnow(), published_by=actor_id,
                                     bundle=bundle, asset_data=asset_data, remarks=remarks, category=category)
    db.add(version)
    db.execute(delete(EnterpriseSkillGrant).where(EnterpriseSkillGrant.code == code))
    db.add_all(EnterpriseSkillGrant(code=code, subject_type=kind, subject_id=subject_id)
               for kind, subject_id in grants)
    audience = _audience_view(grants)
    record_change(db, actor_id, action, code, previous,
                  {"revision": skill.revision, "enabled": skill.enabled, "grants": audience, "category": category})
    response = _view(skill, version, audience, draft)
    db.commit()
    return response


DraftRevision = Annotated[str, Field(pattern=r"^[0-9a-f]{32}$")]


class SkillDraftBody(SkillPublication):
    draft_revision: DraftRevision | None
    source_revision: int | None = Field(default=None, gt=0, lt=2**31 - 1)


class SkillVersionCheck(BaseModel):
    revision: int = Field(ge=0, lt=2**31 - 1)


class SkillDraftCheck(SkillVersionCheck):
    draft_revision: DraftRevision


AttachmentPath = Annotated[str, Query(min_length=1, max_length=220)]


async def _read_upload(request: Request, limit: int) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > limit:
            raise invalid("文件超过大小限制")
        data.extend(chunk)
    return bytes(data)


class SkillImportTarget(SkillVersionCheck):
    revision: int = Field(default=0, ge=0, lt=2**31 - 1)
    code: str | None = Field(default=None, max_length=64)
    draft_revision: DraftRevision | None = None


class GitSkillImport(SkillImportTarget):
    repository: str = Field(min_length=1, max_length=250)
    ref: str = Field(default="HEAD", min_length=1, max_length=200)
    skill_path: str | None = Field(default=None, max_length=220)


@admin_router.get("")
def list_skills(_access: Reader, db: DB) -> dict:
    grants: dict[str, list[tuple[str, int]]] = {}
    for code, kind, subject_id in db.execute(select(
        EnterpriseSkillGrant.code, EnterpriseSkillGrant.subject_type, EnterpriseSkillGrant.subject_id,
    )):
        grants.setdefault(code, []).append((kind, subject_id))
    drafts = {draft.code: draft for draft in db.scalars(select(EnterpriseSkillDraft))}
    items = [_view(skill, version, _audience_view(grants.get(skill.code, [])), drafts.pop(skill.code, None))
             for skill, version in db.execute(_current_versions())]
    items.extend(_draft_only(draft) for draft in drafts.values())
    return {"items": sorted(items, key=lambda item: item["code"])}


@admin_router.get("/audience-options")
def skill_audience_options(user: Annotated[User, Depends(require_admin_portal)], db: DB) -> dict:
    if not effective_permissions(db, user).keys() & {"skills.edit", "skills.publish"}:
        raise forbidden()
    return audience_options(db)


@admin_router.put("/{code}/draft", dependencies=[Depends(require_csrf)])
def save_draft(code: SkillCode, body: SkillDraftBody, access: Editor, db: DB) -> dict:
    return _save_draft(code, body, access.user.id, db)


def _save_draft(
    code: str, body: SkillDraftBody, actor_id: int, db: Session, imported_bundle: dict | None = None,
) -> dict:
    _lock_catalog(db)
    skill = db.get(EnterpriseSkill, code, with_for_update=True)
    draft = db.get(EnterpriseSkillDraft, code, with_for_update=True)
    _version_check(body.revision, skill)
    _draft_check(body.draft_revision, draft)
    enabled, audience = body.enabled, body.grants
    if imported_bundle is not None:
        if draft is not None:
            enabled, audience = draft.enabled, [SkillAudience.model_validate(item) for item in draft.grants]
        elif skill is not None:
            enabled, audience = skill.enabled, [SkillAudience(subject_type=kind, subject_id=subject_id)
                                                for kind, subject_id in _grants(db, code)]
    description, instructions, grants = _validated_contents(db, body.description, body.instructions, audience)
    previous = None if draft is None else draft.revision
    current = None if skill is None else db.get(EnterpriseSkillVersion, (code, skill.revision), with_for_update=True)
    origin = draft if draft is not None else current
    if body.source_revision is not None:
        historical = db.get(EnterpriseSkillVersion, (code, body.source_revision), with_for_update=True)
        if historical is None:
            raise ModelDeskError(404, "invalid_request", "历史版本不存在")
        origin = historical
    bundle, asset_data = (origin.bundle, origin.asset_data) if origin is not None else (None, None)
    if imported_bundle is not None:
        asset_data = imported_bundle["files"]
        bundle = {**imported_bundle, "files": [item["path"] for item in asset_data]}
    if draft is None:
        _check_new_code(db, code)
        draft = EnterpriseSkillDraft(code=code)
        db.add(draft)
    draft.revision = uuid4().hex
    draft.description, draft.instructions = description, instructions
    draft.remarks = _remarks(body, origin)
    draft.category = _category(body, origin)
    draft.enabled, draft.grants = enabled, _audience_view(grants)
    draft.bundle = bundle
    draft.asset_data = asset_data
    draft.updated_at, draft.updated_by = utcnow(), actor_id
    record_change(db, actor_id, "skill.import" if imported_bundle is not None else "skill.draft.save",
                  code, previous, {"revision": draft.revision, "category": draft.category, **_bundle_view(bundle)})
    if skill is None:
        response = _draft_only(draft)
    else:
        response = _view(skill, current, _audience_view(_grants(db, code)), draft)
    db.commit()
    return response


def _remarks(body: SkillPublication, origin: EnterpriseSkillVersion | EnterpriseSkillDraft | None) -> str | None:
    if "remarks" in body.model_fields_set:
        return (body.remarks or "").strip() or None
    return origin.remarks if origin is not None else None


def _category(body: SkillPublication, origin: EnterpriseSkillVersion | EnterpriseSkillDraft | None) -> str | None:
    if "category" in body.model_fields_set:
        return body.category
    return origin.category if origin is not None else None


def _save_import(imported: dict, target: SkillImportTarget, source: dict, actor_id: int, db: Session) -> dict:
    code = imported["code"]
    if target.code is not None and target.code != code:
        raise invalid("导入文件的技能标识与当前技能不一致")
    if target.code is None and (target.revision != 0 or target.draft_revision is not None):
        raise invalid("更新已有技能时需要指定目标技能")
    return _save_draft(code, SkillDraftBody(
        revision=target.revision, draft_revision=target.draft_revision, description=imported["description"],
        instructions=imported["instructions"], grants=[],
    ), actor_id, db, {**imported["bundle"], "source": source})


@admin_router.post("/import/file", dependencies=[Depends(require_csrf)])
async def import_file(
    request: Request, access: Editor, db: DB,
    kind: Literal["markdown", "zip"], revision: Annotated[int, Query(ge=0, lt=2**31 - 1)] = 0,
    code: Annotated[str | None, Query(max_length=64)] = None,
    draft_revision: Annotated[str | None, Query(pattern=r"^[0-9a-f]{32}$")] = None,
    skill_path: Annotated[str | None, Query(max_length=220)] = None,
) -> dict:
    data = await _read_upload(request, SKILL_FILE_LIMIT if kind == "markdown" else ARCHIVE_LIMIT)
    if kind == "markdown":
        imported = await run_in_threadpool(parse_skill, data)
    else:
        imported = await run_in_threadpool(parse_zip, data, skill_path)
    return await run_in_threadpool(_save_import, imported,
        SkillImportTarget(code=code, revision=revision, draft_revision=draft_revision),
        {"kind": kind, "skill_path": skill_path}, access.user.id, db)


@admin_router.post("/import/git", dependencies=[Depends(require_csrf)])
async def import_git(body: GitSkillImport, access: Editor, db: DB) -> dict:
    archive = await download_github(body.repository, body.ref)
    imported = await run_in_threadpool(parse_zip, archive, body.skill_path, repository=True)
    return await run_in_threadpool(_save_import, imported, body, {
        "kind": "git", "repository": body.repository, "ref": body.ref, "skill_path": body.skill_path,
    }, access.user.id, db)


def _change_attachment(
    code: str, path: str, revision: int, draft_revision: str, actor_id: int,
    db: Session, data: bytes | None,
) -> dict:
    safe_parts(path)
    if path.casefold() == "skill.md":
        raise invalid("请在技能正文编辑区修改 SKILL.md")
    _lock_catalog(db)
    skill = db.get(EnterpriseSkill, code, with_for_update=True)
    draft = db.get(EnterpriseSkillDraft, code, with_for_update=True)
    _version_check(revision, skill)
    _draft_check(draft_revision, draft)
    assert draft is not None
    assets = {item["path"].casefold(): item for item in (draft.asset_data or [])}
    key = path.casefold()
    before = assets.get(key)
    if data is None:
        if before is None or before["path"] != path:
            raise ModelDeskError(404, "invalid_request", "附件不存在")
        del assets[key]
    else:
        if any(other.startswith(key + "/") or key.startswith(other + "/")
               for other in assets if other != key):
            raise invalid("文件路径与现有文件或目录冲突")
        assets[key] = {"path": path, "data": base64.b64encode(data).decode("ascii")}
    updated = sorted(assets.values(), key=lambda item: item["path"])
    if len(updated) > 100 or sum(len(base64.b64decode(item["data"])) for item in updated) > ATTACHMENT_LIMIT:
        raise invalid("单个技能最多 100 个附件，附件总大小不超过 2 MiB")
    draft.revision = uuid4().hex
    draft.asset_data = updated
    draft.bundle = {**(draft.bundle or {}), "files": [item["path"] for item in updated]}
    draft.updated_at, draft.updated_by = utcnow(), actor_id
    record_change(db, actor_id, "skill.attachment", code,
                  {"revision": draft_revision, "path": before["path"] if before else None},
                  {"revision": draft.revision, "path": path if data is not None else None})
    response = _draft_only(draft)
    if skill is not None:
        version = db.get(EnterpriseSkillVersion, (code, skill.revision), with_for_update=True)
        response = _view(skill, version, _audience_view(_grants(db, code)), draft)
    db.commit()
    return response


@admin_router.put("/{code}/draft/files", dependencies=[Depends(require_csrf)])
async def upload_attachment(
    request: Request, code: SkillCode, path: AttachmentPath, access: Editor, db: DB,
    revision: Annotated[int, Query(ge=0)], draft_revision: Annotated[str, Query(pattern=r"^[0-9a-f]{32}$")],
) -> dict:
    data = await _read_upload(request, ATTACHMENT_LIMIT)
    return await run_in_threadpool(_change_attachment, code, path, revision, draft_revision,
                                   access.user.id, db, data)


@admin_router.delete("/{code}/draft/files", dependencies=[Depends(require_csrf)])
def delete_attachment(
    code: SkillCode, path: AttachmentPath, body: SkillDraftCheck, access: Editor, db: DB,
) -> dict:
    return _change_attachment(code, path, body.revision, body.draft_revision, access.user.id, db, None)


@admin_router.get("/{code}/files")
def download_attachment(
    code: SkillCode, path: AttachmentPath, _access: Reader, db: DB,
    revision: Annotated[int | None, Query(gt=0)] = None,
) -> Response:
    parts = safe_parts(path)
    row = (db.get(EnterpriseSkillDraft, code) if revision is None
           else db.get(EnterpriseSkillVersion, (code, revision)))
    assets = (row.asset_data or []) if row is not None else []
    file = next((item for item in assets if item["path"] == path), None)
    if file is None:
        raise ModelDeskError(404, "invalid_request", "附件不存在")
    return Response(base64.b64decode(file["data"]), media_type="application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(parts[-1], safe='')}",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })


@admin_router.post("/{code}/publish", dependencies=[Depends(require_csrf)])
def publish_draft(code: SkillCode, body: SkillDraftCheck, access: Publisher, db: DB) -> dict:
    _lock_catalog(db)
    skill = db.get(EnterpriseSkill, code, with_for_update=True)
    draft = db.get(EnterpriseSkillDraft, code, with_for_update=True)
    _version_check(body.revision, skill)
    _draft_check(body.draft_revision, draft)
    assert draft is not None
    description, instructions, grants = _validated_contents(
        db, draft.description, draft.instructions, [SkillAudience.model_validate(item) for item in draft.grants]
    )
    asset_data = draft.asset_data
    db.delete(draft)
    return _publish(db, code, skill, access.user.id, description, instructions, draft.enabled, grants,
                    bundle=draft.bundle, asset_data=asset_data, remarks=draft.remarks, category=draft.category)


@admin_router.delete("/{code}/draft", dependencies=[Depends(require_csrf)])
def discard_draft(code: SkillCode, body: SkillDraftCheck, access: Editor, db: DB) -> dict:
    _lock_catalog(db)
    skill = db.get(EnterpriseSkill, code, with_for_update=True)
    draft = db.get(EnterpriseSkillDraft, code, with_for_update=True)
    _version_check(body.revision, skill)
    _draft_check(body.draft_revision, draft)
    assert draft is not None
    record_change(db, access.user.id, "skill.draft.discard", code, draft.revision, None)
    db.delete(draft)
    item = None
    if skill is not None:
        version = db.get(EnterpriseSkillVersion, (code, skill.revision), with_for_update=True)
        item = _view(skill, version, _audience_view(_grants(db, code)))
    db.commit()
    return {"item": item}


@admin_router.put("/{code}", dependencies=[Depends(require_csrf)])
def publish_skill(code: SkillCode, body: SkillPublication, access: Publisher, db: DB) -> dict:
    _lock_catalog(db)
    skill = db.get(EnterpriseSkill, code, with_for_update=True)
    _version_check(body.revision, skill)
    if db.get(EnterpriseSkillDraft, code, with_for_update=True) is not None:
        raise ModelDeskError(409, "draft_exists", "此技能已有草稿，请通过草稿发布")
    description, instructions, grants = _validated_contents(db, body.description, body.instructions, body.grants)
    current = None if skill is None else db.get(EnterpriseSkillVersion, (code, skill.revision), with_for_update=True)
    return _publish(db, code, skill, access.user.id, description, instructions, body.enabled, grants,
                    bundle=current.bundle if current else None, asset_data=current.asset_data if current else None,
                    remarks=_remarks(body, current), category=_category(body, current))


@admin_router.post("/{code}/unpublish", dependencies=[Depends(require_csrf)])
def unpublish_skill(code: SkillCode, body: SkillVersionCheck, access: Publisher, db: DB) -> dict:
    _lock_catalog(db)
    skill = db.get(EnterpriseSkill, code, with_for_update=True)
    if skill is None:
        raise ModelDeskError(404, "invalid_request", "技能尚未发布")
    _version_check(body.revision, skill)
    version = db.get(EnterpriseSkillVersion, (code, skill.revision), with_for_update=True)
    draft = db.get(EnterpriseSkillDraft, code, with_for_update=True)
    grants = set(_grants(db, code))
    if not skill.enabled:
        return _view(skill, version, _audience_view(grants), draft)
    return _publish(db, code, skill, access.user.id, version.description, version.instructions, False, grants,
                    draft, action="skill.unpublish", bundle=version.bundle, asset_data=version.asset_data,
                    remarks=version.remarks, category=version.category)


@admin_router.get("/{code}/versions")
def list_versions(code: SkillCode, _access: Reader, db: DB,
                  before: Annotated[int | None, Query(gt=0)] = None) -> dict:
    query = select(EnterpriseSkillVersion).where(EnterpriseSkillVersion.code == code)
    if before is not None:
        query = query.where(EnterpriseSkillVersion.revision < before)
    versions = list(db.scalars(query.order_by(EnterpriseSkillVersion.revision.desc()).limit(21)))
    return {"items": [_version_view(row) for row in versions[:20]],
            "next_before": versions[19].revision if len(versions) > 20 else None}


def _visible_versions(user: User):
    granted = select(EnterpriseSkillGrant.code).where(
        visible_to(EnterpriseSkillGrant.subject_type, EnterpriseSkillGrant.subject_id, user)
    )
    return _current_versions().where(EnterpriseSkill.enabled.is_(True), EnterpriseSkill.code.in_(granted))


@client_router.get("/skills")
def visible_skills(auth: Annotated[Authenticated, Depends(require_access)], db: DB) -> JSONResponse:
    rows = db.execute(_visible_versions(auth.user).order_by(EnterpriseSkill.code))
    items = [{"code": skill.code, "revision": skill.revision, "description": version.description, "markdown":
              f"---\n{yaml.safe_dump({**(version.bundle or {}).get('frontmatter', {}), 'name': skill.code,
                                    'description': version.description}, allow_unicode=True, sort_keys=False)}"
              f"---\n\n{version.instructions}\n",
              "has_files": bool((version.bundle or {}).get("files"))} for skill, version in rows]
    return JSONResponse({"items": items}, headers={"Cache-Control": "no-store"})


@client_router.get("/skills/{code}/bundle")
def skill_bundle(
    code: SkillCode, revision: Annotated[int, Query(gt=0)],
    auth: Annotated[Authenticated, Depends(require_access)], db: DB,
) -> JSONResponse:
    row = db.execute(_visible_versions(auth.user).where(
        EnterpriseSkill.code == code, EnterpriseSkill.revision == revision,
    )).one_or_none()
    if row is None:
        raise ModelDeskError(404, "invalid_request", "当前技能版本不存在或不可访问")
    _, version = row
    return JSONResponse({"files": version.asset_data or []},
                        headers={"Cache-Control": "no-store"})
