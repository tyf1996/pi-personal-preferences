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


def call_openai_compatible(config: PreferenceConfig, prompt: str) -> str:
    """Call the configured OpenAI-compatible endpoint without exposing secrets."""

    provider = config.provider
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
        "model": provider["model"],
        "messages": [
            {"role": "system", "content": "Return only the requested JSON object."},
            {"role": "user", "content": prompt},
        ],
        "temperature": provider.get("temperature", 0),
        "max_tokens": provider.get("max_tokens", 2048),
        "response_format": {"type": "json_object"},
    }
    thinking_level = str(provider["thinking_level"])
    if thinking_level != "off":
        request_body["reasoning_effort"] = thinking_level
    request = urllib.request.Request(
        openai_endpoint(endpoint),
        data=stable_json_dumps(request_body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    timeout = float(provider.get("timeout_seconds", 60))
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
    return content
