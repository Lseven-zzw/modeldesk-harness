# ModelDesk server

English | [中文](README.zh.md)

The FastAPI server uses MySQL 5.7. The desktop API is under `/api/v1/modeldesk`, and the management console starts at `/admin/login`. Set `MODELDESK_ORG_NAME` to display an organization name at sign-in.

## Local development

Run `uv sync --locked` and `uv run --locked pytest -q` in `server/`. The tests use SQLite. For a MySQL development instance, run `docker compose -f compose.dev.yml up -d --wait`, then `uv run --locked alembic upgrade head`.

Copy `.env.example` to `.env`. Set a random `MODELDESK_SECRET_KEY`, a Base64-encoded random 32-byte `MODELDESK_MASTER_KEY`, and seed passwords of 12 to 128 characters. Run `uv run --locked python -m app.seed`. From `admin/`, run `pnpm install --frozen-lockfile` and `pnpm build`. Start the server from `server/` with `uv run --locked uvicorn app.main:app --port 8080`.

## Personal and enterprise libraries

Originals are limited to 16 MiB and extracted text to 48,000 UTF-8 bytes. PDF, Office, image, audio and video extraction runs in a background job. A failed enterprise parse can be retried in the console. Configure Tesseract with `MODELDESK_TESSERACT_PATH` and `MODELDESK_OCR_LANGUAGES`, and configure LibreOffice with `MODELDESK_LIBREOFFICE_PATH`. To transcribe audio or video, set `MODELDESK_WHISPER_PATH` and `MODELDESK_WHISPER_MODEL`, and put FFmpeg on the server's PATH.

## Docker Compose

Set `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD`, and the two application keys in `.env`. Set `MODELDESK_COMPOSE_DATABASE_URL` to `mysql+pymysql://modeldesk:<URL-encoded MYSQL_PASSWORD>@mysql:3306/modeldesk?charset=utf8mb4`. Use the desktop-accessible HTTPS origin for `MODELDESK_BASE_URL`.

Run `docker compose up -d --build --wait`, then `docker compose exec server python -m app.seed`. The server runs Alembic on startup. Sign in at `http://127.0.0.1:8080/admin/login` for a local deployment. The public source release targets a fresh database.

## Administration roles and permissions

The built-in administrator can create roles and assign them to employees or groups. Employee and usage roles can be scoped to departments, including their descendants. Model administration can be delegated per model. Assignments and changes to access policy are audited.

## Enterprise skills

Editors can create or import drafts. Publishers review and release specific revisions to employees, groups, or departments. Clients synchronize authorized published skills.

## Enterprise documents

Administrators upload originals, set audience grants, and manage the searchable text. Employees can only read the enabled documents they are allowed to access. Citations include a document revision.

## Enterprise MCP

Administrators register services and configure the audience and allowed tools. The server retains upstream credentials and authorizes each call. Write tools require employee confirmation. Service and call changes are recorded in the audit log.
