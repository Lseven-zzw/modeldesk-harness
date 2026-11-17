"""Explain the employee's currently usable resources using the runtime predicates."""
from collections import defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session, defer

from app.admin.resource_audience import visible_to
from app.admin.routes_documents import _visible as visible_documents
from app.admin.routes_mcp import _audience_ids, matching_grants
from app.admin.routes_skills import _visible_versions
from app.common.clock import billing_month, utcnow
from app.model.visibility import model_grant_filter, visible_models
from app.models import (
    Department, EnterpriseDocument, EnterpriseDocumentGrant, EnterpriseMcpServer, EnterpriseSkillGrant,
    ModelGrant, User, UserGroup,
)
from app.quota.service import resolve_limit, used_tokens


def _sources(db, grant, identifier, user):
    sources = defaultdict(list)
    rows = db.execute(
        select(identifier, grant.subject_type, grant.subject_id)
        .where(visible_to(grant.subject_type, grant.subject_id, user))
        .order_by(grant.subject_type, grant.subject_id)
    )
    for key, kind, subject in rows:
        sources[key].append((kind, subject))
    return sources


def employee_capabilities(db: Session, user: User) -> dict:
    if user.status != 1:
        return {"models": [], "skills": [], "documents": [], "mcp": []}

    departments, groups = _audience_ids(db, user)
    department_names = {row.id: row.name for row in db.scalars(select(Department).where(Department.id.in_(departments)))}
    group_names = {row.id: row.name for row in db.scalars(select(UserGroup).where(UserGroup.id.in_(groups)))}
    model_department_name = db.scalar(select(Department.name).where(Department.code == user.department))

    def explain(pairs):
        names = {"EVERYONE": "全员", "USER": user.display_name, "ADMIN": "内置管理员"}
        result = []
        for kind, subject in pairs:
            if kind == "DEPARTMENT":
                name = department_names.get(subject) if isinstance(subject, int) else model_department_name
            elif kind == "GROUP":
                name = group_names.get(subject)
            else:
                name = names.get(kind)
            result.append({"type": kind, "name": name or str(subject)})
        return result

    model_sources = defaultdict(list)
    for model_id, kind, subject in db.execute(
        select(ModelGrant.model_id, ModelGrant.subject_type, ModelGrant.subject_id)
        .where(model_grant_filter(user)).order_by(ModelGrant.subject_type)
    ):
        model_sources[model_id].append((kind, subject))

    document_sources = _sources(db, EnterpriseDocumentGrant, EnterpriseDocumentGrant.document_id, user)
    skill_sources = _sources(db, EnterpriseSkillGrant, EnterpriseSkillGrant.code, user)
    month = billing_month(utcnow())
    used = used_tokens(db, user.id, month)
    mcp = []
    for row in db.scalars(select(EnterpriseMcpServer).options(defer(EnterpriseMcpServer.token_cipher))
                          .where(EnterpriseMcpServer.enabled.is_(True)).order_by(EnterpriseMcpServer.id)):
        grants = matching_grants(row.grants, user, departments, groups)
        if grants:
            mcp.append({
                "id": row.id, "name": row.name,
                "sources": explain((grant["subject_type"], grant["subject_id"]) for grant in grants),
                "tools": [{"name": tool["name"], "access": tool["access"]} for tool in row.tools if tool.get("enabled")],
            })

    return {
        "models": [{
            "id": row.id, "name": row.display_name,
            "sources": explain([("ADMIN", 0)] if user.role == "ADMIN" else model_sources[row.id]),
            "limit": resolve_limit(db, user, row.id), "used": used, "month": month,
        } for row in visible_models(db, user)],
        "skills": [{"id": skill.code, "name": skill.code, "sources": explain(skill_sources[skill.code])}
                   for skill, _version in db.execute(_visible_versions(user))],
        "documents": [{"id": row.id, "name": row.title, "sources": explain(document_sources[row.id])}
                      for row in db.scalars(visible_documents(user).options(defer(EnterpriseDocument.content)).order_by(EnterpriseDocument.id))],
        "mcp": mcp,
    }
