import pytest

from app.common.errors import ModelDeskError
from app.proxy.upstreams import registry
from app.proxy.upstreams.openai import OpenAIAdapter


class FakeModel:
    upstream_base = "https://api.deepseek.com/v1/"
    upstream_model = "deepseek-chat"
    upstream_kind = "openai"
    extra_config = None
    capabilities = "streaming,tools"


def test_openai_builds_chat_completions_url_and_headers():
    prepared = OpenAIAdapter().build(
        FakeModel(), "sk-test", {"model": "modeldesk:1", "messages": []}, "req_1"
    )
    assert prepared.url == "https://api.deepseek.com/v1/chat/completions"
    assert prepared.headers["Authorization"] == "Bearer sk-test"
    assert prepared.headers["X-Request-ID"] == "req_1"
    assert prepared.body["model"] == "deepseek-chat"
    assert prepared.body["stream"] is True
    assert prepared.body["stream_options"] == {"include_usage": True}


def test_openai_normalizes_usage():
    usage = OpenAIAdapter().normalize_usage(
        {
            "usage": {
                "prompt_tokens": 12,
                "completion_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 3},
            }
        }
    )
    assert (usage.input_tokens, usage.output_tokens, usage.cached_tokens) == (12, 5, 3)


def test_openai_usage_unknown_is_none():
    assert OpenAIAdapter().normalize_usage({}) is None
    assert (
        OpenAIAdapter().normalize_usage({"usage": {"prompt_tokens": None, "completion_tokens": 5}})
        is None
    )


def test_registry_rejects_unimplemented_kind():
    with pytest.raises(ModelDeskError) as exc:
        registry.get_adapter("anthropic")
    assert exc.value.code == "unsupported_parameter"
    assert registry.available_kinds() == ["openai"]


@pytest.mark.parametrize("invalid", [-1, True, "12", 2**31])
def test_openai_rejects_invalid_counts(invalid):
    assert (
        OpenAIAdapter().normalize_usage(
            {"usage": {"prompt_tokens": invalid, "completion_tokens": 5}}
        )
        is None
    )
