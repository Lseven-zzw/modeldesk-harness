from fastapi.testclient import TestClient

from app.admin import spa
from app.main import create_app


def test_spa_falls_back_to_index_and_keeps_paths_inside_static(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<html>modeldesk</html>", encoding="utf-8")
    (tmp_path / "outside.txt").write_text("secret", encoding="utf-8")
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html>modeldesk</html>", encoding="utf-8")
    monkeypatch.setattr(spa, "STATIC_DIR", static)

    app = create_app()
    client = TestClient(app)

    assert client.get("/admin/employees").text == "<html>modeldesk</html>"
    assert client.get("/admin").text == "<html>modeldesk</html>"
    traversal = client.get("/admin/..%2Foutside.txt")
    assert traversal.status_code == 200
    assert traversal.text == "<html>modeldesk</html>"
