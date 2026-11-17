FROM node:24-bookworm-slim AS admin-build
WORKDIR /src/server/admin
RUN npm install -g pnpm@11.28.5
COPY admin/package.json admin/pnpm-lock.yaml admin/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY admin/ ./
RUN pnpm build

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim \
    libreoffice-writer libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*
ENV MODELDESK_OCR_LANGUAGES=eng+chi_sim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_PYTHON_DOWNLOADS=never
WORKDIR /app
RUN pip install --no-cache-dir uv==0.13.7
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY app/ ./app/
COPY migrations/ ./migrations/
COPY alembic.ini docker-entrypoint.sh ./
COPY --from=admin-build /src/server/app/admin/static ./app/admin/static
RUN chmod +x docker-entrypoint.sh
ENV PATH="/app/.venv/bin:$PATH"
EXPOSE 8000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
