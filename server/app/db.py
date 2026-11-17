from collections.abc import Iterator

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.settings import get_settings

_settings = get_settings()
_engine_kwargs = {"pool_pre_ping": True}
if _settings.database_url.startswith("sqlite"):
    _engine_kwargs["connect_args"] = {"check_same_thread": False}
    if _settings.database_url.split("?", 1)[0].endswith(("://", ":memory:")):
        _engine_kwargs["poolclass"] = StaticPool
else:
    _engine_kwargs["pool_size"] = _settings.db_pool_size

engine = create_engine(_settings.database_url, **_engine_kwargs)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def get_session() -> Iterator[Session]:
    with SessionLocal.begin() as session:
        yield session


def create_all(bind: Engine) -> None:
    Base.metadata.create_all(bind)
