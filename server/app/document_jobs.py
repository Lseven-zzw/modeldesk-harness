import logging

from anyio import sleep, to_thread
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import undefer

from app.common.clock import utcnow
from app.library_files import prepare_library_file
from app.models import DocumentFile, EnterpriseDocument

PENDING = "pending"
logger = logging.getLogger(__name__)


def process_next_document(session_factory) -> bool:
    with session_factory() as db:
        file = db.scalar(
            select(DocumentFile).where(DocumentFile.parse_status == PENDING)
            .options(undefer(DocumentFile.data)).order_by(DocumentFile.document_id).limit(1)
        )
        if file is None:
            return False
        document_id, filename, data = file.document_id, file.filename, file.data

    _, _, content, status, _ = prepare_library_file(filename, data)
    with session_factory.begin() as db:
        document = db.get(EnterpriseDocument, document_id, with_for_update=True)
        file = db.get(DocumentFile, document_id, with_for_update=True)
        if document is not None and file is not None and file.parse_status == PENDING:
            file.parse_status = status
            if content and not document.content:
                document.content = content
                document.revision += 1
                document.updated_at = utcnow()
    return True


async def process_document_queue(session_factory) -> None:
    while True:
        await sleep(2)
        try:
            while await to_thread.run_sync(process_next_document, session_factory):
                pass
        except SQLAlchemyError:
            logger.exception("Could not process the document queue")
