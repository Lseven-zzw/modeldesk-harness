import base64
import os

os.environ.setdefault("MODELDESK_DATABASE_URL", "sqlite+pysqlite://")
os.environ.setdefault("MODELDESK_SECRET_KEY", "test-secret")
os.environ.setdefault("MODELDESK_MASTER_KEY", base64.urlsafe_b64encode(b"0" * 32).decode())

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture()
def db():
    from app.models import Base

    engine = create_engine(
        "sqlite+pysqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()
