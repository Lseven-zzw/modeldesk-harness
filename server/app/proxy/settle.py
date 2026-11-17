from collections.abc import Callable
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import ModelCall


def _upsert_monthly(db: Session, user_id: int, month: str, tokens: int, now: datetime) -> None:
    if db.get_bind().dialect.name == "mysql":
        db.execute(
            text(
                "INSERT INTO modeldesk_monthly_usage (user_id, billing_month, used_tokens, updated_at) "
                "VALUES (:u, :m, :t, :n) ON DUPLICATE KEY UPDATE "
                "used_tokens = used_tokens + VALUES(used_tokens), updated_at = VALUES(updated_at)"
            ),
            {"u": user_id, "m": month, "t": tokens, "n": now},
        )
    else:  # 测试用 SQLite；生产只有 MySQL
        db.execute(
            text(
                "INSERT INTO modeldesk_monthly_usage (user_id, billing_month, used_tokens, updated_at) "
                "VALUES (:u, :m, :t, :n) ON CONFLICT(user_id, billing_month) DO UPDATE SET "
                "used_tokens = used_tokens + excluded.used_tokens, updated_at = excluded.updated_at"
            ),
            {"u": user_id, "m": month, "t": tokens, "n": now},
        )


def settle_call(
    *,
    request_id: str,
    user_id: int,
    session_id: str,
    model_id: int,
    model_code: str,
    month: str,
    status: str,
    http_status: int,
    latency_ms: int,
    input_tokens: int | None,
    output_tokens: int | None,
    cached_tokens: int | None,
    now: datetime,
    session_factory: Callable[[], Session] = SessionLocal,
) -> None:
    total = None if input_tokens is None or output_tokens is None else input_tokens + output_tokens
    with session_factory() as db:
        try:
            db.add(
                ModelCall(
                    request_id=request_id,
                    user_id=user_id,
                    session_id=session_id,
                    model_id=0 if db.get_bind().dialect.name == "sqlite" and model_id > 2**63 - 1 else model_id,
                    model_code=model_code,
                    billing_month=month,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cached_tokens=cached_tokens,
                    total_tokens=total,
                    status=status,
                    http_status=http_status,
                    latency_ms=latency_ms,
                    created_at=now,
                )
            )
            db.flush()
            if total is not None:
                _upsert_monthly(db, user_id, month, total, now)
            db.commit()
        except IntegrityError:
            db.rollback()
            if db.scalar(select(ModelCall.id).where(ModelCall.request_id == request_id)) is None:
                raise
