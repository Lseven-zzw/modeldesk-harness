from io import BytesIO

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pptx.util import Inches
from pypdf import PdfWriter

from app import library_files
from app.library_files import prepare_library_file


def test_office_parsers_and_original_only_status(monkeypatch):
    monkeypatch.setattr(library_files, "_ocr_binary", lambda: None)
    word = Document()
    word.add_heading("Travel policy")
    word.add_paragraph("Receipts required")
    sheet = Workbook()
    sheet.active.title = "Expenses"
    sheet.active.append(["Taxi", 15])
    slides = Presentation()
    slide = slides.slides.add_slide(slides.slide_layouts[6])
    slide.shapes.add_textbox(Inches(0), Inches(0), Inches(2), Inches(1)).text = "Approval"
    for name, document, expected in (
        ("policy.docx", word, "Receipts required"),
        ("costs.xlsx", sheet, "[Expenses]\nTaxi\t15"),
        ("guide.pptx", slides, "[第 1 张幻灯片]\nApproval"),
    ):
        output = BytesIO()
        document.save(output)
        _, _, content, status, _ = prepare_library_file(name, output.getvalue())
        assert status == "ready"
        assert expected in content
    pdf = PdfWriter()
    pdf.add_blank_page(100, 100)
    output = BytesIO()
    pdf.write(output)
    assert prepare_library_file("scan.pdf", output.getvalue())[3] == "original_only"
    assert prepare_library_file("damaged.docx", b"broken")[3] == "failed"
    assert prepare_library_file("recording.mp4", b"original")[3] == "original_only"


def test_html_text_excludes_active_content():
    _, _, text, status, _ = prepare_library_file(
        "report.html", b"<h1>Report</h1><script>hidden()</script><style>hidden</style><p>Revenue</p>",
    )
    assert status == "ready"
    assert text == "Report\nRevenue"

def test_scan_ocr_can_read_images_and_pdf_pages(monkeypatch):
    from PIL import Image

    from app import library_files

    monkeypatch.setattr(library_files, "_ocr_binary", lambda: "test-ocr")
    monkeypatch.setattr(library_files, "_ocr_image", lambda image: "Invoice 247")
    image = Image.new("RGB", (160, 80), "white")
    output = BytesIO()
    image.save(output, format="PNG")
    assert prepare_library_file("scan.png", output.getvalue())[2:4] == ("Invoice 247", "ready")
    output = BytesIO()
    image.save(output, format="PDF")
    assert prepare_library_file("scan.pdf", output.getvalue())[2:4] == ("[第 1 页]\nInvoice 247", "ready")

def test_media_transcript_is_searchable(monkeypatch):
    from app import library_files

    monkeypatch.setattr(library_files, "_transcribe", lambda extension, data: "[00:01] Meeting notes")
    assert prepare_library_file("meeting.mp4", b"original")[2:4] == ("[00:01] Meeting notes", "ready")
