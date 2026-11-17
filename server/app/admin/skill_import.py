import base64
import io
import json
import re
import stat
import time
from pathlib import PurePosixPath
from urllib.parse import quote
from zipfile import BadZipFile, ZipFile

import httpx
import yaml

from app.common.errors import ModelDeskError

ARCHIVE_LIMIT = 20 * 1024 * 1024
ATTACHMENT_LIMIT = 2 * 1024 * 1024
SKILL_FILE_LIMIT = 96 * 1024
INSTRUCTIONS_LIMIT = 48_000
DESCRIPTION_LIMIT = 1024
SKILL_CODE = re.compile(r"^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")
REPOSITORY = re.compile(r"(?:https://github\.com/)?([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/?")
GIT_REF = re.compile(r"[A-Za-z0-9_./-]{1,200}")
WINDOWS_RESERVED = re.compile(r"(?i)(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?")


def invalid(message: str) -> ModelDeskError:
    return ModelDeskError(400, "invalid_skill_import", message)


def safe_parts(path: str) -> tuple[str, ...]:
    parts = tuple(path.split("/"))
    if len(path) > 220 or len(parts) > 12 or any(
        not part or len(part) > 100 or part in {".", ".."} or part.endswith((" ", "."))
        or part.startswith(" ") or WINDOWS_RESERVED.fullmatch(part)
        or any(ord(ch) < 32 or ch in '\\:<>"|?*' for ch in part)
        for part in parts
    ):
        raise invalid("技能包包含不安全或过长的文件路径")
    return parts


def parse_skill(data: bytes) -> dict:
    if len(data) > SKILL_FILE_LIMIT:
        raise invalid("SKILL.md 超过大小限制")
    try:
        text = data.decode("utf-8-sig").replace("\r\n", "\n")
        first, header, body = re.split(r"^---[ \t]*\n", text, maxsplit=2, flags=re.MULTILINE)
        if first or len(header) > 8192 or any(isinstance(token, (
            yaml.AliasToken, yaml.AnchorToken, yaml.TagToken,
        )) for token in yaml.scan(header)):
            raise ValueError
        fields = yaml.safe_load(header)
        if not isinstance(fields, dict) or not all(isinstance(key, str) for key in fields):
            raise ValueError
        code, description = fields.pop("name", None), fields.pop("description", None)
        if not isinstance(code, str) or len(code) > 64 or not SKILL_CODE.fullmatch(code):
            raise ValueError
        if not isinstance(description, str) or not 0 < len(description.strip()) <= DESCRIPTION_LIMIT:
            raise ValueError
        if not 0 < len(body.strip().encode("utf-8")) <= INSTRUCTIONS_LIMIT:
            raise ValueError
        if any(key in fields and not isinstance(fields[key], bool) for key in (
            "disable-model-invocation", "user-invocable",
        )):
            raise ValueError
        json.dumps(fields, allow_nan=False)
    except (ValueError, UnicodeError, TypeError, RecursionError, yaml.YAMLError) as exc:
        raise invalid("SKILL.md 需要有效的 YAML 头部、技能标识、描述和正文") from exc
    return {"code": code, "description": description.strip(), "instructions": body.strip(),
            "bundle": {"frontmatter": fields, "files": []}}


def parse_zip(data: bytes, skill_path: str | None = None, *, repository: bool = False) -> dict:
    if len(data) > ARCHIVE_LIMIT:
        raise invalid("ZIP 超过 20 MiB")
    try:
        with ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 5000:
                raise invalid("压缩包条目过多")
            files = {}
            seen = set()
            for entry in entries:
                if "\x00" in entry.orig_filename:
                    raise invalid("压缩包包含无效文件名")
                path = safe_parts(entry.filename.removesuffix("/") if entry.is_dir() else entry.filename)
                if any(part in {"__MACOSX", ".git"} for part in path):
                    continue
                if repository:
                    path = path[1:]
                if not path or entry.is_dir():
                    continue
                folded = tuple(part.casefold() for part in path)
                if folded in seen:
                    raise invalid("压缩包含有重复文件路径")
                seen.add(folded)
                files[path] = entry
            prefix = safe_parts(skill_path.strip("/")) if skill_path and skill_path != "." else ()
            candidates = [path for path in files if path[-1] == "SKILL.md"]
            if skill_path is not None:
                candidates = [path for path in candidates if path[:-1] == prefix]
            elif ("SKILL.md",) in candidates:
                candidates = [("SKILL.md",)]
            if len(candidates) != 1:
                raise invalid("未找到唯一的 SKILL.md，请填写技能所在目录")
            selected = candidates[0]
            entry = files[selected]
            if entry.file_size > SKILL_FILE_LIMIT:
                raise invalid("SKILL.md 超过大小限制")
            for path, entry in files.items():
                if path[:len(selected) - 1] == selected[:-1]:
                    mode = stat.S_IFMT(entry.external_attr >> 16)
                    if mode not in {0, stat.S_IFREG} or entry.flag_bits & 1:
                        raise invalid("技能包不支持链接、特殊文件或加密条目")
            imported = parse_skill(archive.read(files[selected]))
            attachments = [(path[len(selected) - 1:], entry) for path, entry in files.items()
                           if path != selected and path[:len(selected) - 1] == selected[:-1]]
            if len(attachments) > 100 or sum(entry.file_size for _, entry in attachments) > ATTACHMENT_LIMIT:
                raise invalid("技能包最多支持 100 个附件，总解压大小不超过 2 MiB")
            paths = {tuple(part.casefold() for part in path) for path, _ in attachments}
            for path, _ in attachments:
                if any(tuple(part.casefold() for part in path[:i]) in paths for i in range(1, len(path))):
                    raise invalid("附件的文件路径和目录路径冲突")
            imported["bundle"]["files"] = [
                {"path": PurePosixPath(*path).as_posix(), "data": base64.b64encode(archive.read(entry)).decode("ascii")}
                for path, entry in sorted(attachments)
            ]
            return imported
    except (BadZipFile, NotImplementedError, OSError, RuntimeError) as exc:
        raise invalid("无法读取 ZIP 压缩包") from exc


def github_archive_url(repository: str, ref: str) -> str:
    match = REPOSITORY.fullmatch(repository.strip())
    if match is None or not GIT_REF.fullmatch(ref) or any(
        segment in {"", ".", ".."} for segment in ref.split("/")
    ):
        raise invalid("请填写公开 GitHub 仓库和有效的分支、标签或提交")
    owner, name = match.groups()
    name = name.removesuffix(".git")
    if name in {"", ".", ".."} or len(owner) > 39 or len(name) > 100:
        raise invalid("GitHub 仓库地址无效")
    return f"https://codeload.github.com/{owner}/{name}/zip/{quote(ref, safe='/')}"


async def download_github(repository: str, ref: str) -> bytes:
    url = github_archive_url(repository, ref)
    deadline = time.monotonic() + 30
    data = bytearray()
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False, trust_env=False) as client:
            async with client.stream("GET", url, headers={"Accept-Encoding": "identity"}) as response:
                if response.status_code != 200:
                    raise invalid("无法读取公开仓库，请检查仓库和版本")
                async for chunk in response.aiter_raw():
                    if time.monotonic() > deadline:
                        raise invalid("读取 GitHub 仓库超时")
                    data.extend(chunk)
                    if len(data) > ARCHIVE_LIMIT:
                        raise invalid("GitHub 仓库压缩包超过 20 MiB")
    except httpx.HTTPError as exc:
        raise invalid("无法连接 GitHub 或读取仓库超时") from exc
    return bytes(data)
