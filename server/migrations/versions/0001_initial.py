"""Initial MySQL 5.7 schema from ModelDesk design §5.2."""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = (
    """CREATE TABLE modeldesk_user (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  display_name  VARCHAR(100) NOT NULL,
  department    VARCHAR(100) NULL,
  role          VARCHAR(16)  NOT NULL DEFAULT 'EMPLOYEE',
  status        TINYINT      NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_username (username),
  KEY idx_department (department)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_auth_tx (
  id                    VARCHAR(40)  NOT NULL,
  client_id             VARCHAR(64)  NOT NULL,
  redirect_uri          VARCHAR(255) NOT NULL,
  code_challenge        CHAR(43)     NOT NULL,
  code_challenge_method VARCHAR(8)   NOT NULL,
  state                 VARCHAR(128) NOT NULL,
  device_name           VARCHAR(100) NULL,
  client_version        VARCHAR(64)  NULL,
  user_id               BIGINT UNSIGNED NULL,
  ticket_hash           CHAR(64)     NULL,
  ticket_expires_at     DATETIME     NULL,
  status                VARCHAR(16)  NOT NULL,
  expires_at            DATETIME     NOT NULL,
  created_at            DATETIME     NOT NULL,
  PRIMARY KEY (id),
  KEY idx_status_expiry (status, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_session (
  id                 VARCHAR(40)  NOT NULL,
  user_id            BIGINT UNSIGNED NOT NULL,
  device_name        VARCHAR(100) NULL,
  client_version     VARCHAR(64)  NULL,
  access_hash        CHAR(64)     NOT NULL,
  access_expires_at  DATETIME     NOT NULL,
  refresh_family_id  VARCHAR(40)  NOT NULL,
  absolute_expires_at DATETIME    NOT NULL,
  status             VARCHAR(16)  NOT NULL,
  created_at         DATETIME     NOT NULL,
  last_seen_at       DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_access_hash (access_hash),
  KEY idx_user (user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_refresh_token (
  id          VARCHAR(40) NOT NULL,
  session_id  VARCHAR(40) NOT NULL,
  token_hash  CHAR(64)    NOT NULL,
  expires_at  DATETIME    NOT NULL,
  used_at     DATETIME    NULL,
  replaced_by VARCHAR(40) NULL,
  created_at  DATETIME    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_token_hash (token_hash),
  KEY idx_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_model (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(64)  NOT NULL,
  display_name   VARCHAR(200) NOT NULL,
  provider_name  VARCHAR(100) NULL,
  upstream_kind  VARCHAR(32)  NOT NULL DEFAULT 'openai',
  upstream_model VARCHAR(200) NOT NULL,
  upstream_base  VARCHAR(255) NOT NULL,
  api_key_cipher VARBINARY(512) NOT NULL,
  extra_config   JSON         NULL,
  capabilities   VARCHAR(64)  NOT NULL DEFAULT '',
  enabled        TINYINT      NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_model_grant (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  model_id     BIGINT UNSIGNED NOT NULL,
  subject_type VARCHAR(16) NOT NULL,
  subject_id   VARCHAR(64) NOT NULL,
  created_at   DATETIME    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_grant (model_id, subject_type, subject_id),
  KEY idx_subject (subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_credit_rule (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_type        VARCHAR(16) NOT NULL,
  subject_id          VARCHAR(64) NOT NULL,
  model_id            BIGINT UNSIGNED NOT NULL DEFAULT 0,
  monthly_token_limit BIGINT      NOT NULL,
  created_at          DATETIME    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rule (subject_type, subject_id, model_id),
  KEY idx_subject (subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_monthly_usage (
  user_id     BIGINT UNSIGNED NOT NULL,
  billing_month CHAR(7)       NOT NULL,
  used_tokens BIGINT          NOT NULL DEFAULT 0,
  updated_at  DATETIME        NOT NULL,
  PRIMARY KEY (user_id, billing_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
    """CREATE TABLE modeldesk_model_call (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  request_id    VARCHAR(64)  NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  session_id    VARCHAR(40)  NOT NULL,
  model_id      BIGINT UNSIGNED NOT NULL,
  model_code    VARCHAR(64)  NOT NULL,
  billing_month CHAR(7)      NOT NULL,
  input_tokens  INT NULL,
  output_tokens INT NULL,
  cached_tokens INT NULL,
  total_tokens  INT NULL,
  status        VARCHAR(24)  NOT NULL,
  http_status   SMALLINT     NOT NULL,
  latency_ms    INT          NOT NULL,
  created_at    DATETIME     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_request (request_id),
  KEY idx_user_month (user_id, billing_month),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci""",
)

TABLES = (
    "modeldesk_user",
    "modeldesk_auth_tx",
    "modeldesk_session",
    "modeldesk_refresh_token",
    "modeldesk_model",
    "modeldesk_model_grant",
    "modeldesk_credit_rule",
    "modeldesk_monthly_usage",
    "modeldesk_model_call",
)


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    for table in reversed(TABLES):
        op.execute(f"DROP TABLE IF EXISTS {table}")
