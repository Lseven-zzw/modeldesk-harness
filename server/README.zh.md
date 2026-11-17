# ModelDesk 服务端

[English](README.md) | 中文

服务端使用 FastAPI 与 MySQL 5.7，桌面 API 位于 `/api/v1/modeldesk`，管理台入口为 `/admin/login`。可通过 `MODELDESK_ORG_NAME` 设置登录页显示的组织名称。

## 本地开发

在 `server/` 运行 `uv sync --locked` 和 `uv run --locked pytest -q`。测试使用 SQLite。启动 MySQL 开发实例时，运行 `docker compose -f compose.dev.yml up -d --wait`，再执行 `uv run --locked alembic upgrade head`。

复制 `.env.example` 为 `.env`。配置随机的 `MODELDESK_SECRET_KEY`、Base64 编码的随机 32 字节 `MODELDESK_MASTER_KEY` 和长度为 12 至 128 位的初始化密码。运行 `uv run --locked python -m app.seed`。在 `admin/` 运行 `pnpm install --frozen-lockfile` 和 `pnpm build`，再回到 `server/` 运行 `uv run --locked uvicorn app.main:app --port 8080`。

## 个人与企业资料库

原件大小上限 16 MiB，提取正文上限 48,000 UTF-8 字节。PDF、Office、图片和音视频在后台解析，企业资料解析失败可在管理台重试。用 `MODELDESK_TESSERACT_PATH` 和 `MODELDESK_OCR_LANGUAGES` 配置 Tesseract，用 `MODELDESK_LIBREOFFICE_PATH` 配置 LibreOffice。音视频转写需要 `MODELDESK_WHISPER_PATH`、`MODELDESK_WHISPER_MODEL`，以及已加入服务端 PATH 的 FFmpeg。

## Docker Compose

在 `.env` 设置 `MYSQL_ROOT_PASSWORD`、`MYSQL_PASSWORD` 和两项应用密钥。将 `MODELDESK_COMPOSE_DATABASE_URL` 设为 `mysql+pymysql://modeldesk:<URL 编码后的 MYSQL_PASSWORD>@mysql:3306/modeldesk?charset=utf8mb4`，并把 `MODELDESK_BASE_URL` 设为桌面端可访问的 HTTPS 地址。

运行 `docker compose up -d --build --wait`，再运行 `docker compose exec server python -m app.seed`。服务启动时会执行 Alembic 迁移。本地部署可通过 `http://127.0.0.1:8080/admin/login` 登录。公开版使用全新的数据库。

## 后台角色与权限

内置管理员可创建角色并分配给员工或用户组。员工管理和用量权限可按部门及其下级部门授权，模型管理可按单个模型委派。授权和策略变更会记录到审计日志。

## 企业技能库

编辑者可新建或导入草稿。发布者审核后将指定版本开放给员工、用户组或部门。客户端同步获准访问的已发布版本。

## 企业资料库

管理员上传原件、设置开放范围并维护可检索正文。员工只能阅读已启用且对其开放的资料。引用包含资料版本。

## 企业 MCP

管理员注册服务并配置开放范围和可用工具。服务端保管上游凭据并逐次检查权限。写工具须由员工确认。服务变更和调用会记录到审计日志。
