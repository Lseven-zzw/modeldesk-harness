from datetime import datetime

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

UnsignedID = BigInteger().with_variant(mysql.BIGINT(unsigned=True), "mysql")
AutoID = UnsignedID.with_variant(Integer(), "sqlite")
TinyInt = SmallInteger().with_variant(mysql.TINYINT(), "mysql")
CipherBytes = LargeBinary(512).with_variant(mysql.VARBINARY(512), "mysql")


class Base(DeclarativeBase):
    pass


class AuthorizationAudit(Base):
    __tablename__ = "modeldesk_authorization_audit"

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    actor_id: Mapped[int] = mapped_column(UnsignedID)
    action: Mapped[str] = mapped_column(String(48))
    target: Mapped[str] = mapped_column(String(100))
    details: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class EnterpriseSkill(Base):
    __tablename__ = "modeldesk_enterprise_skill"
    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer)
    enabled: Mapped[bool] = mapped_column(Boolean)


class EnterpriseSkillVersion(Base):
    __tablename__ = "modeldesk_enterprise_skill_version"
    code: Mapped[str] = mapped_column(
        String(64), ForeignKey("modeldesk_enterprise_skill.code", ondelete="CASCADE"), primary_key=True,
    )
    revision: Mapped[int] = mapped_column(Integer, primary_key=True)
    description: Mapped[str] = mapped_column(String(1024))
    remarks: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(32))
    instructions: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    published_by: Mapped[int | None] = mapped_column(UnsignedID)
    bundle: Mapped[dict | None] = mapped_column(JSON)
    asset_data: Mapped[list[dict] | None] = mapped_column(JSON, deferred=True)


class EnterpriseSkillDraft(Base):
    __tablename__ = "modeldesk_enterprise_skill_draft"
    code: Mapped[str] = mapped_column(String(64), primary_key=True)
    revision: Mapped[str] = mapped_column(String(32))
    description: Mapped[str] = mapped_column(String(1024))
    remarks: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(32))
    instructions: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean)
    grants: Mapped[list[dict]] = mapped_column(JSON)
    updated_by: Mapped[int] = mapped_column(UnsignedID)
    updated_at: Mapped[datetime] = mapped_column(DateTime)
    bundle: Mapped[dict | None] = mapped_column(JSON)
    asset_data: Mapped[list[dict] | None] = mapped_column(JSON, deferred=True)


class EnterpriseSkillGrant(Base):
    __tablename__ = "modeldesk_enterprise_skill_grant"
    code: Mapped[str] = mapped_column(
        String(64), ForeignKey("modeldesk_enterprise_skill.code", ondelete="CASCADE"), primary_key=True,
    )
    subject_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    subject_id: Mapped[int] = mapped_column(UnsignedID, primary_key=True)


class EnterpriseDocument(Base):
    __tablename__ = "modeldesk_enterprise_document"
    __table_args__ = (Index("ix_modeldesk_document_owner", "owner_id"), {"mysql_charset": "utf8mb4"})

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    owner_id: Mapped[int | None] = mapped_column(UnsignedID)
    title: Mapped[str] = mapped_column(String(200))
    content: Mapped[str] = mapped_column(Text)
    format: Mapped[str] = mapped_column(String(16))
    enabled: Mapped[bool] = mapped_column(Boolean)
    revision: Mapped[int] = mapped_column(Integer)
    updated_by: Mapped[int] = mapped_column(UnsignedID)
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class DocumentFile(Base):
    __tablename__ = "modeldesk_document_file"
    __table_args__ = {"mysql_charset": "utf8mb4"}

    document_id: Mapped[int] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_enterprise_document.id", ondelete="CASCADE"), primary_key=True,
    )
    filename: Mapped[str] = mapped_column(String(240))
    media_type: Mapped[str] = mapped_column(String(120))
    parse_status: Mapped[str] = mapped_column(String(16))
    size: Mapped[int] = mapped_column(Integer)
    data: Mapped[bytes] = mapped_column(LargeBinary().with_variant(mysql.LONGBLOB(), "mysql"), deferred=True)


class EnterpriseDocumentGrant(Base):
    __tablename__ = "modeldesk_enterprise_document_grant"

    document_id: Mapped[int] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_enterprise_document.id", ondelete="CASCADE"), primary_key=True,
    )
    subject_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    subject_id: Mapped[int] = mapped_column(UnsignedID, primary_key=True)


class EnterpriseMcpServer(Base):
    __tablename__ = "modeldesk_enterprise_mcp_server"
    __table_args__ = {"mysql_charset": "utf8mb4"}

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100))
    endpoint: Mapped[str] = mapped_column(String(512))
    description: Mapped[str] = mapped_column(Text)
    guide: Mapped[str] = mapped_column(Text)
    token_cipher: Mapped[bytes | None] = mapped_column(CipherBytes)
    enabled: Mapped[bool] = mapped_column(Boolean)
    revision: Mapped[int] = mapped_column(Integer)
    grants: Mapped[list[dict]] = mapped_column(JSON)
    tools: Mapped[list[dict]] = mapped_column(JSON)
    discovered_at: Mapped[datetime | None] = mapped_column(DateTime)


class Department(Base):
    __tablename__ = "modeldesk_department"
    __table_args__ = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_bin"}

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(100), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    archived: Mapped[bool] = mapped_column(Boolean, server_default=text("0"))
    parent_id: Mapped[int | None] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_department.id", name="fk_department_parent"), index=True
    )


class UserGroup(Base):
    __tablename__ = "modeldesk_user_group"

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)


class UserGroupMember(Base):
    __tablename__ = "modeldesk_user_group_member"

    group_id: Mapped[int] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_user_group.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_user.id", ondelete="CASCADE"), primary_key=True, index=True
    )


class UserGroupRole(Base):
    __tablename__ = "modeldesk_user_group_role"

    group_id: Mapped[int] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_user_group.id", ondelete="CASCADE"), primary_key=True
    )
    role_code: Mapped[str] = mapped_column(
        String(48), ForeignKey("modeldesk_admin_role.code", ondelete="CASCADE"), primary_key=True, index=True
    )
    department: Mapped[str] = mapped_column(
        String(100).with_variant(mysql.VARCHAR(100, collation="utf8mb4_bin"), "mysql"),
        primary_key=True,
    )
    include_descendants: Mapped[bool] = mapped_column(Boolean, server_default=text("0"))


class User(Base):
    __tablename__ = "modeldesk_user"
    __table_args__ = (
        UniqueConstraint("username", name="uk_username"),
        Index("idx_department", "department"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64))
    password_hash: Mapped[str] = mapped_column(String(100))
    display_name: Mapped[str] = mapped_column(String(100))
    department: Mapped[str | None] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(16), server_default=text("'EMPLOYEE'"))
    status: Mapped[int] = mapped_column(TinyInt, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(DateTime)


class AuthTx(Base):
    __tablename__ = "modeldesk_auth_tx"
    __table_args__ = (
        Index("idx_status_expiry", "status", "expires_at"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64))
    redirect_uri: Mapped[str] = mapped_column(String(255))
    code_challenge: Mapped[str] = mapped_column(CHAR(43))
    code_challenge_method: Mapped[str] = mapped_column(String(8))
    state: Mapped[str] = mapped_column(String(128))
    device_name: Mapped[str | None] = mapped_column(String(100))
    client_version: Mapped[str | None] = mapped_column(String(64))
    user_id: Mapped[int | None] = mapped_column(UnsignedID)
    ticket_hash: Mapped[str | None] = mapped_column(CHAR(64))
    ticket_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(16))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class SessionRow(Base):
    __tablename__ = "modeldesk_session"
    __table_args__ = (
        UniqueConstraint("access_hash", name="uk_access_hash"),
        Index("idx_user", "user_id", "status"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    user_id: Mapped[int] = mapped_column(UnsignedID)
    device_name: Mapped[str | None] = mapped_column(String(100))
    client_version: Mapped[str | None] = mapped_column(String(64))
    access_hash: Mapped[str] = mapped_column(CHAR(64))
    access_expires_at: Mapped[datetime] = mapped_column(DateTime)
    refresh_family_id: Mapped[str] = mapped_column(String(40))
    absolute_expires_at: Mapped[datetime] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)


class RefreshToken(Base):
    __tablename__ = "modeldesk_refresh_token"
    __table_args__ = (
        UniqueConstraint("token_hash", name="uk_token_hash"),
        Index("idx_session", "session_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(40))
    token_hash: Mapped[str] = mapped_column(CHAR(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)
    replaced_by: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime)


class ModelChannel(Base):
    __tablename__ = "modeldesk_model_channel"

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100))
    upstream_kind: Mapped[str] = mapped_column(String(32))
    upstream_base: Mapped[str] = mapped_column(String(255))
    api_key_cipher: Mapped[bytes] = mapped_column(CipherBytes)
    key_hint: Mapped[str] = mapped_column(String(4))


class ModelRow(Base):
    __tablename__ = "modeldesk_model"
    delegation_revision: Mapped[int] = mapped_column(UnsignedID, server_default=text("0"))
    __table_args__ = (
        UniqueConstraint("code", name="uk_code"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(64))
    display_name: Mapped[str] = mapped_column(String(200))
    provider_name: Mapped[str | None] = mapped_column(String(100))
    channel_id: Mapped[int | None] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_model_channel.id", name="fk_model_channel"), index=True
    )
    channel: Mapped[ModelChannel | None] = relationship(lazy="selectin")
    upstream_kind: Mapped[str] = mapped_column(String(32), server_default=text("'openai'"))
    upstream_model: Mapped[str] = mapped_column(String(200))
    upstream_base: Mapped[str] = mapped_column(String(255))
    api_key_cipher: Mapped[bytes] = mapped_column(CipherBytes)
    extra_config: Mapped[dict | None] = mapped_column(JSON)
    # The optional ctx:<tokens> entry declares the model context window.
    capabilities: Mapped[str] = mapped_column(String(64), server_default=text("''"))
    enabled: Mapped[int] = mapped_column(TinyInt, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(DateTime)


class ModelGrant(Base):
    __tablename__ = "modeldesk_model_grant"
    __table_args__ = (
        UniqueConstraint("model_id", "subject_type", "subject_id", name="uk_grant"),
        Index("idx_subject", "subject_type", "subject_id"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    model_id: Mapped[int] = mapped_column(UnsignedID)
    subject_type: Mapped[str] = mapped_column(String(16))
    subject_id: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime)


class ModelAdminGrant(Base):
    __tablename__ = "modeldesk_model_admin_subject_grant"

    model_id: Mapped[int] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_model.id", ondelete="CASCADE"), primary_key=True
    )
    subject_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    subject_id: Mapped[int] = mapped_column(UnsignedID, primary_key=True)
    permission: Mapped[str] = mapped_column(String(48), primary_key=True)
    include_descendants: Mapped[bool] = mapped_column(Boolean, server_default=text("0"))
    __table_args__ = (Index("ix_model_admin_subject", "subject_type", "subject_id"),)


class CreditRule(Base):
    __tablename__ = "modeldesk_credit_rule"
    __table_args__ = (
        UniqueConstraint("subject_type", "subject_id", "model_id", name="uk_rule"),
        # MySQL index names are per table, while SQLite names are per database.
        Index("idx_subject", "subject_type", "subject_id").ddl_if(dialect="mysql"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    subject_type: Mapped[str] = mapped_column(String(16))
    subject_id: Mapped[str] = mapped_column(String(64))
    model_id: Mapped[int] = mapped_column(UnsignedID, server_default=text("0"))
    monthly_token_limit: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class MonthlyUsage(Base):
    __tablename__ = "modeldesk_monthly_usage"
    __table_args__ = (
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    user_id: Mapped[int] = mapped_column(UnsignedID, primary_key=True)
    billing_month: Mapped[str] = mapped_column(CHAR(7), primary_key=True)
    used_tokens: Mapped[int] = mapped_column(BigInteger, server_default=text("0"))
    updated_at: Mapped[datetime] = mapped_column(DateTime)


class ModelCall(Base):
    __tablename__ = "modeldesk_model_call"
    __table_args__ = (
        UniqueConstraint("request_id", name="uk_request"),
        Index("idx_user_month", "user_id", "billing_month"),
        Index("idx_created", "created_at"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
        },
    )

    id: Mapped[int] = mapped_column(AutoID, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(String(64))
    user_id: Mapped[int] = mapped_column(UnsignedID)
    session_id: Mapped[str] = mapped_column(String(40))
    model_id: Mapped[int] = mapped_column(UnsignedID)
    model_code: Mapped[str] = mapped_column(String(64))
    billing_month: Mapped[str] = mapped_column(CHAR(7))
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cached_tokens: Mapped[int | None] = mapped_column(Integer)
    total_tokens: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(24))
    http_status: Mapped[int] = mapped_column(SmallInteger)
    latency_ms: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime)


class AdminRole(Base):
    __tablename__ = "modeldesk_admin_role"

    code: Mapped[str] = mapped_column(String(48), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))


class AdminRolePermission(Base):
    __tablename__ = "modeldesk_admin_role_permission"

    role_code: Mapped[str] = mapped_column(
        String(48), ForeignKey("modeldesk_admin_role.code", ondelete="CASCADE"), primary_key=True
    )
    permission: Mapped[str] = mapped_column(String(48), primary_key=True)


class AdminUserRole(Base):
    __tablename__ = "modeldesk_admin_user_role"
    __table_args__ = (Index("idx_admin_user_role_code", "role_code"),)

    user_id: Mapped[int] = mapped_column(
        UnsignedID, ForeignKey("modeldesk_user.id", ondelete="CASCADE"), primary_key=True
    )
    role_code: Mapped[str] = mapped_column(
        String(48), ForeignKey("modeldesk_admin_role.code", ondelete="CASCADE"), primary_key=True
    )
    # An empty string denotes a global assignment.
    department: Mapped[str] = mapped_column(
        String(100).with_variant(mysql.VARCHAR(100, collation="utf8mb4_bin"), "mysql"),
        primary_key=True,
    )
    include_descendants: Mapped[bool] = mapped_column(Boolean, server_default=text("0"))
