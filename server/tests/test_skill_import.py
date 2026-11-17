from io import BytesIO
from types import SimpleNamespace
from zipfile import ZipFile

from fastapi.testclient import TestClient

from app.admin import routes_skills
from app.admin.skill_import import github_archive_url
from app.auth.admin_session import require_browser_user, require_csrf
from app.auth.deps import require_access
from app.common.clock import utcnow
from app.db import get_session
from app.main import create_app
from app.models import User


def skill(name):
    return (f"---\nname: {name}\ndescription: Imported example\nuser-invocable: false\n---\n"
            "Read [example](references/example.md).").encode()


def archive(files):
    output = BytesIO()
    with ZipFile(output, "w") as bundle:
        for path, content in files.items():
            bundle.writestr(path, content)
    return output.getvalue()


def test_import_methods_publish_only_after_review_and_keep_attachments(db, monkeypatch):
    user = User(username="root", password_hash="unused", display_name="Root",
                role="ADMIN", created_at=utcnow())
    db.add(user)
    db.commit()
    app = create_app()
    app.dependency_overrides.update({
        get_session: lambda: db,
        require_browser_user: lambda: user,
        require_csrf: lambda: None,
        require_access: lambda: SimpleNamespace(user=user),
    })
    client = TestClient(app)
    base = "/api/admin/skills"
    markdown = client.post(base + "/import/file?kind=markdown", content=skill("plain"))
    assert markdown.status_code == 200 and markdown.json()["draft"]["files"] == []
    unsafe = archive({"SKILL.md": skill("unsafe"), "../escape.txt": "bad"})
    assert client.post(base + "/import/file?kind=zip", content=unsafe).status_code == 400
    zip_file = archive({"pack/SKILL.md": skill("zipped"), "pack/references/example.md": "example"})
    zipped = client.post(base + "/import/file?kind=zip", content=zip_file)
    assert zipped.status_code == 200 and zipped.json()["draft"]["files"] == ["references/example.md"]
    assert client.post(base + "/import/file?kind=zip", content=zip_file).status_code == 409
    assert client.get("/api/v1/modeldesk/skills").json()["items"] == []

    async def github(repository, ref):
        assert github_archive_url(repository, ref) == "https://codeload.github.com/example/repo/zip/main"
        return archive({
            "repo-main/skills/review/SKILL.md": skill("git-review"),
            "repo-main/skills/review/references/example.md": "remote",
            "repo-main/skills/other/SKILL.md": skill("other"),
        })

    monkeypatch.setattr(routes_skills, "download_github", github)
    git = client.post(base + "/import/git", json={
        "repository": "https://github.com/example/repo", "ref": "main", "skill_path": "skills/review",
    })
    assert git.status_code == 200 and git.json()["draft"]["source"]["kind"] == "git"
    draft = zipped.json()["draft"]
    body = {
        "revision": 0, "draft_revision": draft["revision"], "description": draft["description"],
        "remarks": "Internal reviewer note",
        "instructions": draft["instructions"], "grants": [{"subject_type": "EVERYONE", "subject_id": 0}],
    }
    edited = client.put(base + "/zipped/draft", json=body).json()["draft"]
    published = client.post(base + "/zipped/publish", json={
        "revision": 0, "draft_revision": edited["revision"],
    })
    assert published.status_code == 200
    [visible] = client.get("/api/v1/modeldesk/skills").json()["items"]
    assert visible["has_files"] and "user-invocable: false" in visible["markdown"]
    assert "remarks" not in visible and "Internal reviewer note" not in visible["markdown"]
    url = "/api/v1/modeldesk/skills/zipped/bundle"
    assert client.get(url + "?revision=1").json() == {
        "files": [{"path": "references/example.md", "data": "ZXhhbXBsZQ=="}],
    }
    assert client.get(url + "?revision=2").status_code == 404
    replacement = client.post(base + "/import/file?kind=markdown&code=zipped&revision=1",
                              content=skill("zipped")).json()["draft"]
    assert replacement["grants"] == body["grants"] and replacement["files"] == []
    assert replacement["remarks"] == "Internal reviewer note"
    assert client.post(base + "/zipped/publish", json={
        "revision": 1, "draft_revision": replacement["revision"],
    }).status_code == 200
    assert client.get(url + "?revision=1").status_code == 404
    restored = client.put(base + "/zipped/draft", json={
        **body, "revision": 2, "draft_revision": None, "source_revision": 1, "remarks": None,
    }).json()["draft"]
    assert restored["files"] == ["references/example.md"]
    assert restored["remarks"] is None
    assert client.post(base + "/zipped/publish", json={
        "revision": 2, "draft_revision": restored["revision"],
    }).status_code == 200
    assert client.get(url + "?revision=3").json()["files"][0]["path"] == "references/example.md"
    versions = client.get(base + "/zipped/versions").json()["items"]
    assert [item["remarks"] for item in versions] == [None, "Internal reviewer note", "Internal reviewer note"]
    assert client.post(base + "/zipped/unpublish", json={"revision": 3}).status_code == 200
    assert client.get(url + "?revision=3").status_code == 404


def test_manually_created_skill_supports_draft_attachment_management(db):
    user = User(username="root", password_hash="unused", display_name="Root",
                role="ADMIN", created_at=utcnow())
    db.add(user)
    db.commit()
    app = create_app()
    app.dependency_overrides.update({
        get_session: lambda: db,
        require_browser_user: lambda: user,
        require_csrf: lambda: None,
        require_access: lambda: SimpleNamespace(user=user),
    })
    client = TestClient(app)
    path = "/api/admin/skills/manual"
    published_bundle = "/api/v1/modeldesk/skills/manual/bundle"
    payload = {"revision": 0, "draft_revision": None, "description": "Manual skill",
               "instructions": "Read references/guide.md",
               "grants": [{"subject_type": "EVERYONE", "subject_id": 0}]}
    draft = client.put(path + "/draft", json=payload).json()["draft"]
    file_path = "references/guide.md"
    params = {"path": file_path, "revision": 0, "draft_revision": draft["revision"]}
    files = path + "/draft/files"
    assert client.put(files, params={**params, "path": "../escape"}, content=b"x").status_code == 400
    first = client.put(files, params=params, content=b"first")
    assert first.status_code == 200 and first.json()["draft"]["files"] == [file_path]
    assert client.put(files, params=params, content=b"stale").status_code == 409
    params["draft_revision"] = first.json()["draft"]["revision"]
    second = client.put(files, params=params, content=b"second").json()["draft"]
    download = client.get(path + "/files", params={"path": file_path})
    assert download.content == b"second"
    assert download.headers["content-disposition"].startswith("attachment;")
    assert client.get(published_bundle, params={"revision": 1}).status_code == 404
    assert client.post(path + "/publish", json={
        "revision": 0, "draft_revision": second["revision"],
    }).status_code == 200
    draft = client.put(path + "/draft", json={**payload, "revision": 1}).json()["draft"]
    removed = client.request("DELETE", files, params={"path": file_path}, json={
        "revision": 1, "draft_revision": draft["revision"],
    }).json()["draft"]
    assert removed["files"] == []
    assert client.get(path + "/files", params={"path": file_path}).status_code == 404
    assert client.get(path + "/files", params={"path": file_path, "revision": 1}).content == b"second"
    assert len(client.get(published_bundle, params={"revision": 1}).json()["files"]) == 1
    assert client.post(path + "/publish", json={
        "revision": 1, "draft_revision": removed["revision"],
    }).status_code == 200
    assert client.get(published_bundle, params={"revision": 2}).json()["files"] == []
