from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, Path, Query, UploadFile
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field, TypeAdapter, ValidationError
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session, defer

from app.admin.authorization_audit import record_change
from app.admin.rbac import Access
from app.admin.resource_audience import (
    ResourceAudience,
    audience_options,
    validate_audience,
    visible_to,
)
from app.admin.routes_employees import _no_store
from app.auth.admin_session import require_csrf, require_permission
from app.auth.deps import require_access
from app.auth.service import Authenticated
from app.common.clock import utcnow
from app.common.errors import ModelDeskError
from app.db import get_session
from app.document_jobs import PENDING
from app.library_files import MAX_FILE_BYTES, prepare_library_file, validate_library_file
from app.models import DocumentFile
from app.models import EnterpriseDocument as Document
from app.models import EnterpriseDocumentGrant as Grant

admin_router = APIRouter(prefix="/api/admin/documents", dependencies=[Depends(_no_store)])
client_router = APIRouter(prefix="/api/v1/modeldesk/documents", dependencies=[Depends(_no_store)])
DB = Annotated[Session, Depends(get_session)]
Reader = Annotated[Access, Depends(require_permission("documents.read"))]
Manager = Annotated[Access, Depends(require_permission("documents.manage"))]
Employee = Annotated[Authenticated, Depends(require_access)]
DocumentID = Annotated[int, Path(gt=0, le=2**63 - 1)]
Cursor = Annotated[int | None, Query(gt=0, le=2**63 - 1)]
Search = Annotated[str, Query(max_length=120)]


Library = Literal["enterprise", "personal"]
Revision = Annotated[int | None, Query(gt=0)]


class DocumentBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=48_000)
    format: Literal["markdown", "text"]
    enabled: bool = True
    grants: list[ResourceAudience] = Field(max_length=500)


class DocumentUpdate(DocumentBody):
    revision: int = Field(gt=0, lt=2**31 - 1)


def _metadata(row: Document) -> dict:
    return {
        "id": row.id, "title": row.title, "format": row.format, "enabled": row.enabled,
        "revision": row.revision, "updated_at": row.updated_at.isoformat() + "Z",
    }


def _grant_view(db: Session, document_id: int) -> list[dict]:
    rows = db.execute(select(Grant.subject_type, Grant.subject_id).where(Grant.document_id == document_id)
                      .order_by(Grant.subject_type, Grant.subject_id))
    return [{"subject_type": kind, "subject_id": subject} for kind, subject in rows]


def _missing() -> ModelDeskError:
    return ModelDeskError(404, "invalid_request", "资料不存在或不可访问")


def _matching(query, term: str, before: int | None, limit: int = 30):
    if before is not None:
        query = query.where(Document.id < before)
    if term:
        query = query.where(or_(
            Document.title.icontains(term, autoescape=True),
            Document.content.icontains(term, autoescape=True),
        ))
    return query.order_by(Document.id.desc()).limit(limit + 1)


def _visible(user):
    ids = select(Grant.document_id).where(visible_to(Grant.subject_type, Grant.subject_id, user))
    return select(Document).where(Document.owner_id.is_(None), Document.enabled.is_(True), Document.id.in_(ids))


def _excerpt(content: str, term: str) -> str:
    position = content.lower().find(term.lower()) if term else 0
    start = max(0, position - 100)
    result = content[start:start + 320].strip()
    return ("…" if start else "") + result + ("…" if start + 320 < len(content) else "")


@admin_router.get("")
def list_documents(_access: Reader, db: DB, q: Search = "", before: Cursor = None) -> dict:
    rows = list(db.scalars(_matching(select(Document).where(Document.owner_id.is_(None)).options(defer(Document.content)), q.strip(), before)))
    files = _page_file_metadata(db, rows[:30])
    return {
        "items": [{**_metadata(row), **files.get(row.id, {})} for row in rows[:30]],
        "next_before": rows[29].id if len(rows) > 30 else None,
    }


@admin_router.get("/audience-options")
def document_audience_options(_access: Manager, db: DB) -> dict:
    return audience_options(db)


@admin_router.get("/{document_id}")
def view_document(document_id: DocumentID, _access: Reader, db: DB) -> dict:
    row = db.get(Document, document_id)
    if row is None or row.owner_id is not None:
        raise _missing()
    return {**_metadata(row), **_file_metadata(db, row.id), "content": row.content, "grants": _grant_view(db, row.id)}


def _save(db: Session, row: Document, body: DocumentBody, actor_id: int, previous: dict | None) -> dict:
    title = body.title.strip()
    requires_text = row.id is None or db.get(DocumentFile, row.id) is None
    if not title or (requires_text and not body.content.strip()) or len(body.content.encode("utf-8")) > 48_000:
        raise ModelDeskError(400, "invalid_request", "标题和正文不能为空，正文最多 48,000 字节")
    grants = validate_audience(db, body.grants)
    row.title, row.content, row.format, row.enabled = title, body.content, body.format, body.enabled
    row.revision = previous["revision"] + 1 if previous else 1
    row.updated_by, row.updated_at = actor_id, utcnow()
    db.add(row)
    db.flush()
    db.execute(delete(Grant).where(Grant.document_id == row.id))
    db.add_all(Grant(document_id=row.id, subject_type=kind, subject_id=subject)
               for kind, subject in sorted(grants))
    audience = [{"subject_type": kind, "subject_id": subject} for kind, subject in sorted(grants)]
    summary = {**_metadata(row), "grants": audience}
    record_change(db, actor_id, "document.save", str(row.id), previous, summary)
    db.commit()
    return {**summary, "content": row.content}


@admin_router.post("", status_code=201, dependencies=[Depends(require_csrf)])
def create_document(body: DocumentBody, access: Manager, db: DB) -> dict:
    return _save(db, Document(), body, access.user.id, None)


@admin_router.put("/{document_id}", dependencies=[Depends(require_csrf)])
def update_document(document_id: DocumentID, body: DocumentUpdate, access: Manager, db: DB) -> dict:
    row = db.get(Document, document_id, with_for_update=True)
    if row is None or row.owner_id is not None:
        raise _missing()
    if row.revision != body.revision:
        raise ModelDeskError(409, "revision_conflict", "资料已更新，请重新打开后编辑")
    return _save(db, row, body, access.user.id, {**_metadata(row), "grants": _grant_view(db, row.id)})


def _library(user, library: Library):
    if library == "personal":
        return select(Document).where(Document.owner_id == user.id)
    return _visible(user)


def _file_view(file: DocumentFile | None) -> dict:
    if file is None:
        return {}
    return {"filename": file.filename, "media_type": file.media_type,
            "parse_status": file.parse_status, "size": file.size}


def _file_metadata(db: Session, document_id: int) -> dict:
    return _file_view(db.get(DocumentFile, document_id))


def _page_file_metadata(db: Session, rows: list[Document]) -> dict[int, dict]:
    if not rows:
        return {}
    files = db.scalars(select(DocumentFile).where(DocumentFile.document_id.in_([row.id for row in rows])))
    return {file.document_id: _file_view(file) for file in files}


def _save_file(db: Session, upload: UploadFile, actor_id: int, *, owner_id: int | None, grants: set):
    data = upload.file.read(MAX_FILE_BYTES + 1)
    name, media_type, extension = validate_library_file(upload.filename, data)
    content, status = "", PENDING
    if extension in ("md", "txt", "csv", "html", "htm"):
        _, _, content, status, _ = prepare_library_file(name, data)
    row = Document(owner_id=owner_id, title=name[:200], content=content,
                   format="markdown" if extension == "md" else "text",
                   enabled=True, revision=1, updated_by=actor_id, updated_at=utcnow())
    db.add(row)
    db.flush()
    db.add(DocumentFile(document_id=row.id, filename=name, media_type=media_type,
                        parse_status=status, size=len(data), data=data))
    db.add_all(Grant(document_id=row.id, subject_type=kind, subject_id=subject)
               for kind, subject in sorted(grants))
    db.flush()
    summary = {**_metadata(row), **_file_metadata(db, row.id)}
    if owner_id is None:
        record_change(db, actor_id, "document.save", str(row.id), None, {
            **summary, "grants": _grant_view(db, row.id),
        })
    db.commit()
    return summary


@admin_router.post("/files", status_code=201, dependencies=[Depends(require_csrf)])
def upload_enterprise_file(
    access: Manager, db: DB, file: Annotated[UploadFile, File()],
    grants: Annotated[str, Form(max_length=24_000)] = "[]",
):
    try:
        audience = TypeAdapter(list[ResourceAudience]).validate_json(grants)
    except ValidationError as error:
        raise ModelDeskError(400, "invalid_request", "资料开放范围无效") from error
    if len(audience) > 500:
        raise ModelDeskError(400, "invalid_request", "资料开放范围最多 500 项")
    return _save_file(db, file, access.user.id, owner_id=None, grants=validate_audience(db, audience))


@client_router.post("/personal/files", status_code=201)
def upload_personal_file(auth: Employee, db: DB, file: Annotated[UploadFile, File()]):
    return _save_file(db, file, auth.user.id, owner_id=auth.user.id, grants=set())


@admin_router.post("/{document_id}/retry-parse", dependencies=[Depends(require_csrf)])
def retry_document_parse(document_id: DocumentID, access: Manager, db: DB) -> dict:
    row = db.get(Document, document_id, with_for_update=True)
    if row is None or row.owner_id is not None:
        raise _missing()
    file = db.get(DocumentFile, document_id, with_for_update=True)
    if file is None:
        raise _missing()
    if file.parse_status == "failed":
        previous = _file_view(file)
        file.parse_status = PENDING
        record_change(db, access.user.id, "document.retry_parse", str(document_id), previous, _file_view(file))
        db.commit()
    elif file.parse_status != PENDING:
        raise ModelDeskError(409, "invalid_request", "只有解析失败的文件可以重试")
    return {**_metadata(row), **_file_view(file)}


@client_router.get("")
def search_documents(
    auth: Employee, db: DB, q: Search = "", before: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=30)] = 30, library: Library = "enterprise",
) -> JSONResponse:
    term = q.strip()
    rows = list(db.scalars(_matching(_library(auth.user, library), term, before, limit)))
    files = _page_file_metadata(db, rows[:limit])
    return JSONResponse({
        "items": [{**_metadata(row), **files.get(row.id, {}), "excerpt": _excerpt(row.content, term)}
                  for row in rows[:limit]],
        "next_before": rows[limit - 1].id if len(rows) > limit else None,
    }, headers={"Cache-Control": "no-store"})


def _client_document(db: Session, user, library: Library, document_id: int, revision: int | None):
    row = db.scalar(_library(user, library).where(Document.id == document_id))
    if row is None:
        raise _missing()
    if revision is not None and row.revision != revision:
        raise ModelDeskError(409, "revision_conflict", "资料版本已更新，请重新选择")
    return row


@client_router.get("/{document_id}")
def read_document(
    document_id: DocumentID, auth: Employee, db: DB,
    library: Library = "enterprise", revision: Revision = None,
) -> JSONResponse:
    row = _client_document(db, auth.user, library, document_id, revision)
    return JSONResponse({**_metadata(row), **_file_metadata(db, row.id), "content": row.content},
                        headers={"Cache-Control": "no-store"})


def _download(db: Session, document_id: int) -> Response:
    file = db.get(DocumentFile, document_id)
    if file is None:
        raise _missing()
    return Response(file.data, media_type="application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(file.filename, safe='')}",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    })


@admin_router.get("/{document_id}/file")
def download_enterprise_file(document_id: DocumentID, _access: Reader, db: DB) -> Response:
    row = db.get(Document, document_id)
    if row is None or row.owner_id is not None:
        raise _missing()
    return _download(db, document_id)


@client_router.get("/{document_id}/file")
def download_document(
    document_id: DocumentID, auth: Employee, db: DB,
    library: Library = "enterprise", revision: Revision = None,
) -> Response:
    row = _client_document(db, auth.user, library, document_id, revision)
    return _download(db, row.id)


@client_router.delete("/{document_id}", status_code=204)
def delete_personal_document(document_id: DocumentID, auth: Employee, db: DB) -> Response:
    row = _client_document(db, auth.user, "personal", document_id, None)
    db.execute(delete(DocumentFile).where(DocumentFile.document_id == row.id))
    db.delete(row)
    db.commit()
    return Response(status_code=204)
