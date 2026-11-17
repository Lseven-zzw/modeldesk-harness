import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).resolve().parent / "static"
_ENTRY_SCRIPT = re.compile(r'<script type="module" crossorigin src="(/admin/assets/[-\w.]+\.js)"></script>')
_ENTRY_STYLE = re.compile(r'<link rel="stylesheet" crossorigin href="(/admin/assets/[-\w.]+\.css)"')


def admin_entry_assets() -> tuple[str, str] | None:
    """Use the same versioned frontend entry as the management SPA."""
    try:
        index = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    script = _ENTRY_SCRIPT.search(index)
    style = _ENTRY_STYLE.search(index)
    if script and style:
        return script[1], style[1]
    return None


def mount_admin_ui(app: FastAPI) -> None:
    root = STATIC_DIR.resolve()
    index = root / "index.html"
    if not index.is_file():
        return  # 未构建管理台时不影响 API；本地用 Vite dev server

    for name in ("brand", "assets"):
        directory = root / name
        if directory.is_dir():
            app.mount(f"/admin/{name}", StaticFiles(directory=directory), name=f"admin-{name}")

    @app.get("/admin", include_in_schema=False)
    @app.get("/admin/{path:path}", include_in_schema=False)
    def admin_spa() -> FileResponse:
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
