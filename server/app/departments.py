from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.common.errors import ModelDeskError
from app.models import Department


def register_legacy_department(db: Session, code: str | None) -> None:
    """Keep the existing employee API's department strings as stable codes."""
    if not code:
        return
    lookup = select(Department).where(Department.code == code).with_for_update()
    existing = db.scalar(lookup)
    if existing is not None:
        if existing.archived:
            raise ModelDeskError(400, "invalid_request", "部门已归档")
        return
    try:
        with db.begin_nested():
            db.add(Department(code=code, name=code))
    except IntegrityError:
        existing = db.scalar(lookup)
        if existing is None:
            raise
        if existing.archived:
            raise ModelDeskError(400, "invalid_request", "部门已归档")
