from app.common.errors import ModelDeskError

ALLOWED_FIELDS = frozenset(
    {
        "model",
        "messages",
        "tools",
        "tool_choice",
        "stream",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "stop",
        "n",
    }
)


def validate_chat_payload(payload: dict) -> dict:
    unknown = sorted(set(payload) - ALLOWED_FIELDS)
    if unknown:
        raise ModelDeskError(400, "unsupported_parameter", f"不支持的字段：{', '.join(unknown)}")
    if "max_tokens" in payload and "max_completion_tokens" in payload:
        raise ModelDeskError(400, "unsupported_parameter", "max_tokens 与 max_completion_tokens 互斥")
    if type(payload.get("n", 1)) is not int or payload.get("n", 1) != 1:
        raise ModelDeskError(400, "unsupported_parameter", "n 仅支持 1")
    stream_options = payload.get("stream_options")
    if stream_options is not None and (
        not isinstance(stream_options, dict) or set(stream_options) - {"include_usage"}
    ):
        raise ModelDeskError(400, "unsupported_parameter", "stream_options 仅支持 include_usage")
    if type(payload.get("stream", False)) is not bool or (
        stream_options is not None and type(stream_options.get("include_usage", False)) is not bool
    ):
        raise ModelDeskError(400, "invalid_request", "流式选项必须是布尔值")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ModelDeskError(400, "invalid_request", "messages 不能为空")
    for message in messages:
        if not isinstance(message, dict):
            raise ModelDeskError(400, "invalid_request", "消息必须是对象")
        content = message.get("content")
        if isinstance(content, list):
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "text":
                    raise ModelDeskError(400, "unsupported_parameter", "首期不支持多模态消息")
    return payload
