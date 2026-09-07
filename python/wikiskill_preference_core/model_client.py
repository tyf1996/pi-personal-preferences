"""Small provider transport shared by preference model operations."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from typing import Any

from .config import PreferenceConfig
from .contracts import stable_json_dumps
from .errors import PreferenceEvolutionError
from .sanitizing import sanitize_text

MAX_RESPONSE_BYTES = 512 * 1024


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def _open_without_redirect(request: urllib.request.Request, timeout: float):
    return urllib.request.build_opener(_NoRedirectHandler()).open(request, timeout=timeout)


def openai_endpoint(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return f"{base}/chat/completions"


def _validated_base_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in {"http", "https"} or not parsed.netloc
                or parsed.username is not None or parsed.password is not None
                or parsed.query or parsed.fragment):
            raise ValueError
    except ValueError as exc:
        raise PreferenceEvolutionError(
            "provider endpoint must be an HTTP(S) URL without credentials or query"
        ) from exc
    return value


def call_openai_compatible_result(
    config: PreferenceConfig,
    prompt: str,
    selection: dict[str, Any] | None = None,
    *,
    provider_override: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Call the configured endpoint and return bounded text plus verified usage metadata."""

    provider = config.provider if provider_override is None else provider_override
    if provider["name"] == "pi":
        raise PreferenceEvolutionError("Pi model calls must be bridged through the Pi extension")
    api_key_env = str(provider["api_key_env"])
    api_key = os.environ.get(api_key_env)
    if not api_key:
        raise PreferenceEvolutionError(f"provider credential environment variable is missing: {api_key_env}")
    base_url = provider.get("base_url") or os.environ.get("OPENAI_BASE_URL")
    if not base_url:
        raise PreferenceEvolutionError("provider.base_url or OPENAI_BASE_URL is required")
    if "\r" in api_key or "\n" in api_key:
        raise PreferenceEvolutionError("provider credential contains a forbidden newline")
    endpoint = _validated_base_url(str(base_url))
    request_body: dict[str, Any] = {
        "model": selection["model_id"] if selection is not None else provider["model"],
        "messages": [
            {"role": "system", "content": "Return only the requested JSON object."},
            {"role": "user", "content": prompt},
        ],
        "temperature": provider.get("temperature", 0),
        "max_tokens": selection["max_tokens"] if selection is not None else provider.get("max_tokens", 2048),
        "response_format": {"type": "json_object"},
    }
    thinking_level = str(selection["thinking_level"] if selection is not None else provider["thinking_level"])
    if thinking_level != "off":
        request_body["reasoning_effort"] = thinking_level
    request = urllib.request.Request(
        openai_endpoint(endpoint),
        data=stable_json_dumps(request_body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    timeout = float(selection["timeout_seconds"] if selection is not None else provider.get("timeout_seconds", 60))
    try:
        with _open_without_redirect(request, timeout) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        # urllib errors can contain deployment-specific details. Keep the
        # diagnostic redacted and never include the response body or key.
        detail = sanitize_text(str(exc)).text[:500]
        raise PreferenceEvolutionError(f"preference model request failed: {detail}") from exc
    if len(payload) > MAX_RESPONSE_BYTES:
        raise PreferenceEvolutionError("preference model response exceeded 512 KiB")
    try:
        decoded = json.loads(payload.decode("utf-8"))
        content = decoded["choices"][0]["message"]["content"]
    except (UnicodeDecodeError, KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise PreferenceEvolutionError("provider response does not contain choices[0].message.content") from exc
    if isinstance(content, list):
        content = "".join(str(item.get("text", "")) if isinstance(item, dict) else str(item) for item in content)
    if not isinstance(content, str):
        raise PreferenceEvolutionError("provider response content must be text")
    raw_usage = decoded.get("usage") if isinstance(decoded, dict) else None
    prompt_tokens = raw_usage.get("prompt_tokens") if isinstance(raw_usage, dict) else None
    completion_tokens = raw_usage.get("completion_tokens") if isinstance(raw_usage, dict) else None
    total_tokens = raw_usage.get("total_tokens") if isinstance(raw_usage, dict) else None
    known = (
        type(prompt_tokens) is int and prompt_tokens >= 0
        and type(completion_tokens) is int and completion_tokens >= 0
    )
    if known and (type(total_tokens) is not int or total_tokens < 0):
        total_tokens = prompt_tokens + completion_tokens
    selected_model = str(selection["model_id"] if selection is not None else provider["model"])
    selected_limit = int(selection["max_tokens"] if selection is not None else provider.get("max_tokens", 2048))
    usage = {
        "known": known,
        "input_tokens": prompt_tokens if known else None,
        "output_tokens": completion_tokens if known else None,
        "total_tokens": total_tokens if known else None,
        # The OpenAI-compatible response contract does not provide reliable
        # billing data. A missing cost is unknown, never zero.
        "cost_usd": None,
        "cost_status": "unknown",
        "provider_id": "fake" if provider["name"] == "fake" else "openai_compatible",
        "model_id": selected_model,
        "max_tokens": selected_limit,
    }
    return content, usage


def call_openai_compatible(
    config: PreferenceConfig,
    prompt: str,
    selection: dict[str, Any] | None = None,
    *,
    provider_override: dict[str, Any] | None = None,
) -> str:
    """Text-only wrapper retained for deterministic group classification."""
    return call_openai_compatible_result(
        config,
        prompt,
        selection,
        provider_override=provider_override,
    )[0]
