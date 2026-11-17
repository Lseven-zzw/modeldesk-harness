from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def billing_month(now: datetime | None = None) -> str:
    aware = now if now is not None else datetime.now(UTC)
    if aware.tzinfo is None:
        aware = aware.replace(tzinfo=UTC)
    return aware.astimezone(SHANGHAI).strftime("%Y-%m")


def month_start(month: str) -> datetime:
    year, mon = (int(part) for part in month.split("-"))
    return datetime(year, mon, 1, tzinfo=SHANGHAI)


def resets_at(month: str) -> str:
    start = month_start(month)
    nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return nxt.isoformat()
