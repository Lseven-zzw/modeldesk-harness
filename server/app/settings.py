from functools import lru_cache

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="MODELDESK_", env_file=".env", extra="ignore")

    database_url: str = "mysql+pymysql://modeldesk:modeldesk@127.0.0.1:3306/modeldesk?charset=utf8mb4"
    secret_key: str = "dev-only-not-for-production"
    master_key: str = "ZGV2LW9ubHktMzItYnl0ZS1rZXktMDAwMDAwMDAwMDA="
    base_url: str = "http://127.0.0.1:8080"
    enabled: bool = True
    contract_version: str = "0.1.0"
    org_id: str = "modeldesk"
    org_name: str = "默认组织"

    access_ttl_seconds: int = 600
    refresh_ttl_seconds: int = 2_592_000
    session_ttl_seconds: int = 2_592_000
    auth_tx_ttl_seconds: int = 300
    ticket_ttl_seconds: int = 60
    default_monthly_tokens: int = 10_000_000

    upstream_connect_timeout: float = 10.0
    upstream_read_timeout: float = 120.0
    upstream_write_timeout: float = 30.0
    upstream_pool_timeout: float = 10.0
    upstream_pool_max_connections: int = 20
    db_pool_size: int = 10

    @field_validator("access_ttl_seconds")
    @classmethod
    def _cap_access_ttl(cls, value: int) -> int:
        if value <= 0 or value > 600:
            raise ValueError("MODELDESK_ACCESS_TTL_SECONDS must be in 1..600")
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
