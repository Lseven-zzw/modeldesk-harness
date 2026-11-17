from app.common.errors import ModelDeskError
from app.proxy.upstreams.base import UpstreamAdapter
from app.proxy.upstreams.openai import OpenAIAdapter

_ADAPTERS: dict[str, UpstreamAdapter] = {OpenAIAdapter.kind: OpenAIAdapter()}


def get_adapter(kind: str) -> UpstreamAdapter:
    adapter = _ADAPTERS.get(kind)
    if adapter is None:
        raise ModelDeskError(400, "unsupported_parameter", f"上游协议 {kind} 尚未实现")
    return adapter


def available_kinds() -> list[str]:
    return sorted(_ADAPTERS)
