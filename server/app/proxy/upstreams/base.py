from dataclasses import dataclass
from typing import Protocol

from app.models import ModelRow


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int
    cached_tokens: int | None = None

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(frozen=True)
class PreparedUpstream:
    url: str
    headers: dict[str, str]
    body: dict


class UpstreamAdapter(Protocol):
    kind: str

    def build(
        self, model: ModelRow, api_key: str, payload: dict, request_id: str, *, upstream_base: str | None = None
    ) -> PreparedUpstream: ...

    def normalize_usage(self, payload: dict) -> Usage | None: ...
