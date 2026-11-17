import os
import sys

from dotenv import dotenv_values
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.common.clock import utcnow
from app.common.crypto import SecretBox
from app.common.passwords import hash_password
from app.db import SessionLocal
from app.departments import register_legacy_department
from app.models import CreditRule, ModelGrant, ModelRow, User
from app.settings import Settings, get_settings


class UpstreamSeed:
    def __init__(
        self, *, code: str, display_name: str, upstream_model: str, upstream_base: str, api_key: str
    ) -> None:
        self.code = code
        self.display_name = display_name
        self.upstream_model = upstream_model
        self.upstream_base = upstream_base
        self.api_key = api_key


def seed(
    db: Session,
    settings: Settings,
    *,
    admin_password: str,
    employee_password: str,
    upstream: UpstreamSeed | None = None,
) -> list[str]:
    if not all(12 <= len(password) <= 128 for password in (admin_password, employee_password)):
        raise ValueError("种子密码须为 12 至 128 位")
    notes: list[str] = []
    now = utcnow()

    def ensure_user(
        username: str, display_name: str, department: str | None, role: str, password: str
    ) -> None:
        existing = db.scalar(select(User.id).where(User.username == username))
        if existing is not None:
            notes.append(f"kept user {username}")
            return
        register_legacy_department(db, department)
        db.add(
            User(
                username=username,
                password_hash=hash_password(password),
                display_name=display_name,
                department=department,
                role=role,
                status=1,
                created_at=now,
            )
        )
        db.flush()
        notes.append(f"created user {username}")

    ensure_user("admin", "管理员", None, "ADMIN", admin_password)
    ensure_user("zhang.san", "张三", "剪辑部", "EMPLOYEE", employee_password)
    ensure_user("li.si", "李四", "策划部", "EMPLOYEE", employee_password)

    rule = db.scalar(
        select(CreditRule).where(
            CreditRule.subject_type == "DEFAULT",
            CreditRule.subject_id == "*",
            CreditRule.model_id == 0,
        )
    )
    if rule is None:
        db.add(
            CreditRule(
                subject_type="DEFAULT",
                subject_id="*",
                model_id=0,
                monthly_token_limit=settings.default_monthly_tokens,
                created_at=now,
            )
        )
        notes.append("created default credit rule")
    else:
        notes.append("kept default credit rule")

    if upstream is None:
        notes.append("skipped model seed (no upstream configured)")
    else:
        model = db.scalar(select(ModelRow).where(ModelRow.code == upstream.code))
        if model is None:
            model = ModelRow(
                code=upstream.code,
                display_name=upstream.display_name,
                provider_name=None,
                upstream_kind="openai",
                upstream_model=upstream.upstream_model,
                upstream_base=upstream.upstream_base.rstrip("/"),
                api_key_cipher=SecretBox(settings.master_key).encrypt(upstream.api_key),
                extra_config={"key_hint": upstream.api_key[-4:]},
                capabilities="streaming,tools",
                enabled=1,
                created_at=now,
            )
            db.add(model)
            db.flush()
            notes.append(f"created model {upstream.code}")
            db.add(
                ModelGrant(
                    model_id=model.id, subject_type="EVERYONE", subject_id="*", created_at=now
                )
            )
            notes.append("granted EVERYONE")
        else:
            notes.append(f"kept model and grants {upstream.code}")
    db.commit()
    return notes


def main() -> int:
    settings = get_settings()
    env = {**dotenv_values(".env"), **os.environ}
    admin_password = env.get("MODELDESK_SEED_ADMIN_PASSWORD") or ""
    employee_password = env.get("MODELDESK_SEED_EMPLOYEE_PASSWORD") or ""
    if not all(12 <= len(password) <= 128 for password in (admin_password, employee_password)):
        print("Set both seed passwords to 12–128 characters", file=sys.stderr)
        return 2

    base = (env.get("MODELDESK_SEED_UPSTREAM_BASE") or "").strip()
    key = (env.get("MODELDESK_SEED_UPSTREAM_KEY") or "").strip()
    if bool(base) != bool(key):
        print("Set both seed upstream base and key, or leave both empty", file=sys.stderr)
        return 2
    upstream = None
    if base and key:
        upstream = UpstreamSeed(
            code=(env.get("MODELDESK_SEED_MODEL_CODE") or "deepseek-chat"),
            display_name=(env.get("MODELDESK_SEED_MODEL_NAME") or "DeepSeek Chat"),
            upstream_model=(env.get("MODELDESK_SEED_UPSTREAM_MODEL") or "deepseek-chat"),
            upstream_base=base,
            api_key=key,
        )

    with SessionLocal() as db:
        for note in seed(
            db,
            settings,
            admin_password=admin_password,
            employee_password=employee_password,
            upstream=upstream,
        ):
            print(note)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
