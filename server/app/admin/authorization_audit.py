from sqlalchemy.orm import Session

from app.common.clock import utcnow
from app.models import AuthorizationAudit


def record_change(
    db: Session, actor_id: int, action: str, target: str, before: object, after: object
) -> None:
    if before != after:
        db.add(AuthorizationAudit(
            actor_id=actor_id,
            action=action,
            target=target,
            details={"before": before, "after": after},
            created_at=utcnow(),
        ))
