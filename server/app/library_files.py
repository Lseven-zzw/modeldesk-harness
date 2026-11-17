"""Extract searchable text while preserving the original library file."""
from html.parser import HTMLParser
from io import BytesIO
from os import environ
from os import name as os_name
from pathlib import Path, PurePosixPath
from shutil import which
from subprocess import run
from tempfile import TemporaryDirectory
from zipfile import ZipFile

import xlrd
from docx import Document
from openpyxl import load_workbook
from PIL import Image
from pptx import Presentation
from pypdf import PdfReader
from pypdfium2 import PdfDocument

from app.common.errors import ModelDeskError

MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TEXT_BYTES = 48_000
MIME_TYPES = {
    "md": "text/markdown", "txt": "text/plain", "csv": "text/csv",
    "html": "text/html", "htm": "text/html", "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "doc": "application/msword", "xls": "application/vnd.ms-excel",
    "ppt": "application/vnd.ms-powerpoint",
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif",
    "webp": "image/webp", "bmp": "image/bmp", "tif": "image/tiff", "tiff": "image/tiff",
    "mp3": "audio/mpeg", "wav": "audio/wav", "m4a": "audio/mp4", "aac": "audio/aac",
    "ogg": "audio/ogg", "flac": "audio/flac", "mp4": "video/mp4",
    "mov": "video/quicktime", "webm": "video/webm", "mkv": "video/x-matroska",
    "avi": "video/x-msvideo",
}


class HtmlText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


def _ocr_binary():
    binary = environ.get("MODELDESK_TESSERACT_PATH") or which("tesseract")
    if not binary and os_name == "nt":
        candidate = Path(environ.get("ProgramFiles", "C:/Program Files")) / "Tesseract-OCR/tesseract.exe"
        if candidate.is_file():
            binary = str(candidate)
    return binary


def _ocr_image(image):
    binary = _ocr_binary()
    if not binary:
        return ""
    if image.width * image.height > 32_000_000:
        raise ValueError("Image exceeds OCR pixel limit")
    image.thumbnail((2200, 2200))
    source = BytesIO()
    image.convert("RGB").save(source, format="PNG")
    result = run(
        [binary, "stdin", "stdout", "-l", environ.get("MODELDESK_OCR_LANGUAGES", "eng")],
        input=source.getvalue(), capture_output=True, timeout=8, check=True,
    )
    return result.stdout.decode("utf-8").strip()


def _pdf_parts(data):
    raster = None
    try:
        for index, page in enumerate(PdfReader(BytesIO(data)).pages, 1):
            text = page.extract_text()
            if not text.strip() and index <= 3 and _ocr_binary():
                if raster is None:
                    raster = PdfDocument(data)
                source = raster[index - 1]
                try:
                    width, height = source.get_size()
                    bitmap = source.render(scale=min(2, 2200 / max(width, height)))
                    try:
                        text = _ocr_image(bitmap.to_pil().copy())
                    finally:
                        bitmap.close()
                finally:
                    source.close()
            if text.strip():
                yield f"[第 {index} 页]\n{text}"
    finally:
        if raster is not None:
            raster.close()


def _legacy_office(extension, data):
    if extension == "xls":
        workbook = xlrd.open_workbook(file_contents=data, on_demand=True)
        try:
            for sheet in workbook.sheets():
                yield f"[{sheet.name}]"
                for index in range(min(sheet.nrows, 10_000)):
                    yield "\t".join(str(value) for value in sheet.row_values(index)[:256])
        finally:
            workbook.release_resources()
        return
    binary = environ.get("MODELDESK_LIBREOFFICE_PATH") or which("soffice")
    if not binary:
        return
    target = {"doc": "docx", "ppt": "pptx"}[extension]
    with TemporaryDirectory(prefix="modeldesk-office-") as directory:
        root = Path(directory)
        source = root / f"document.{extension}"
        source.write_bytes(data)
        run([binary, f"-env:UserInstallation={(root / 'profile').as_uri()}", "--headless",
             "--convert-to", target, "--outdir", directory, str(source)],
            capture_output=True, timeout=30, check=True)
        converted = root / f"document.{target}"
        if converted.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("Converted Office file exceeds extraction limit")
        yield from _text_parts(target, converted.read_bytes())


def _transcribe(extension, data):
    binary = environ.get("MODELDESK_WHISPER_PATH")
    model = environ.get("MODELDESK_WHISPER_MODEL")
    if not binary or not model:
        return ""
    with TemporaryDirectory(prefix="modeldesk-transcript-") as directory:
        root = Path(directory)
        media = root / f"source.{extension}"
        media.write_bytes(data)
        run([binary, str(media), "--model", model, "--output_dir", directory,
             "--output_format", "vtt", "--fp16", "False", "--verbose", "False"],
            capture_output=True, timeout=180, check=True)
        transcript = root / "source.vtt"
        if transcript.stat().st_size > 4 * 1024 * 1024:
            raise ValueError("Transcript exceeds extraction limit")
        return transcript.read_text(encoding="utf-8").removeprefix("WEBVTT").strip()


def _text_parts(extension, data):
    if extension in ("md", "txt", "csv"):
        yield data.decode("utf-8-sig")
        return
    if extension in ("html", "htm"):
        parser = HtmlText()
        parser.feed(data.decode("utf-8-sig"))
        yield from parser.parts
        return
    if extension == "pdf":
        yield from _pdf_parts(data)
        return
    if MIME_TYPES[extension].startswith("image/"):
        if _ocr_binary():
            with Image.open(BytesIO(data)) as image:
                yield _ocr_image(image)
        return
    if MIME_TYPES[extension].startswith(("audio/", "video/")):
        yield _transcribe(extension, data)
        return
    if extension in ("doc", "xls", "ppt"):
        yield from _legacy_office(extension, data)
        return
    source = BytesIO(data)
    if extension not in ("docx", "xlsx", "pptx"):
        return
    with ZipFile(source) as archive:
        if sum(item.file_size for item in archive.infolist()) > 96 * 1024 * 1024:
            raise ValueError("Office archive exceeds extraction limit")
    source.seek(0)
    if extension == "docx":
        document = Document(source)
        yield from (paragraph.text for paragraph in document.paragraphs)
        for table in document.tables:
            for row in table.rows:
                yield "\t".join(cell.text for cell in row.cells)
    elif extension == "xlsx":
        workbook = load_workbook(source, read_only=True, data_only=True, keep_links=False)
        try:
            for sheet in workbook.worksheets:
                yield f"[{sheet.title}]"
                for row in sheet.iter_rows(values_only=True, max_col=min(sheet.max_column or 256, 256), max_row=min(sheet.max_row or 10000, 10000)):
                    yield "\t".join("" if value is None else str(value) for value in row).rstrip()
        finally:
            workbook.close()
    else:
        for index, slide in enumerate(Presentation(source).slides, 1):
            yield f"[第 {index} 张幻灯片]"
            yield from (shape.text for shape in slide.shapes if shape.has_text_frame)


def validate_library_file(filename: str | None, data: bytes) -> tuple[str, str, str]:
    name = PurePosixPath((filename or "").replace("\\", "/")).name
    extension = PurePosixPath(name).suffix.lower().lstrip(".")
    if extension not in MIME_TYPES or len(name) > 240:
        raise ModelDeskError(400, "invalid_request", "不支持的文件类型或文件名过长")
    if not data or len(data) > MAX_FILE_BYTES:
        raise ModelDeskError(400, "invalid_request", "文件不能为空且不能超过 16 MiB")
    return name, MIME_TYPES[extension], extension


def prepare_library_file(filename: str | None, data: bytes):
    name, media_type, extension = validate_library_file(filename, data)
    parts = []
    size = 0
    status = "original_only"
    try:
        for part in _text_parts(extension, data):
            if not part.strip():
                continue
            encoded = part.encode("utf-8")
            remaining = MAX_TEXT_BYTES - size
            parts.append(encoded[:remaining].decode("utf-8", errors="ignore"))
            size += len(encoded) + 1
            if size >= MAX_TEXT_BYTES:
                status = "truncated"
                break
        else:
            if parts:
                status = "ready"
    except Exception:  # noqa: BLE001 - Third-party parsers must leave the original available.
        parts = []
        status = "failed"
    return name, media_type, "\n".join(parts), status, extension
