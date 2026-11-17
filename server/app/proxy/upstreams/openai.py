from app.models import ModelRow
from app.proxy.upstreams.base import PreparedUpstream, Usage


def _valid_count(value: object) -> bool:
    return type(value) is int and 0 <= value <= 2**31 - 1


class OpenAIAdapter:
    kind = "openai"

    def build(
        self, model: ModelRow, api_key: str, payload: dict, request_id: str, *, upstream_base: str | None = None
    ) -> PreparedUpstream:
        body = {k: v for k, v in payload.items() if k != "model"}
        body["model"] = model.upstream_model
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
        return PreparedUpstream(
            url=(upstream_base or model.upstream_base).rstrip("/") + "/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
                "X-Request-ID": request_id,
            },
            body=body,
        )

    def normalize_usage(self, payload: dict) -> Usage | None:
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            return None
        prompt, completion = usage.get("prompt_tokens"), usage.get("completion_tokens")
        if (
            not _valid_count(prompt)
            or not _valid_count(completion)
            or prompt + completion > 2**31 - 1
        ):
            return None
        details = usage.get("prompt_tokens_details")
        cached = details.get("cached_tokens") if isinstance(details, dict) else None
        return Usage(
            prompt, completion, cached if _valid_count(cached) and cached <= prompt else None
        )
