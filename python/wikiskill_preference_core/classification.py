"""The model-backed classifier for personal preference groups."""

from __future__ import annotations

import json
import os
from dataclasses import replace
from typing import Any

from .config import PreferenceConfig
from .contracts import (
    GroupClassificationRequest,
    GroupClassificationResult,
    stable_json_dumps,
)
from .errors import PreferenceContractError, PreferenceEvolutionError
from .model_client import MAX_RESPONSE_BYTES, call_openai_compatible
from .sanitizing import sanitize_text

PROMPT_VERSION = "personal-preference-group-classifier-v1"


def _safe_request(request: GroupClassificationRequest) -> GroupClassificationRequest:
    return replace(
        request,
        preference_text=sanitize_text(request.preference_text).text,
        task_summary=sanitize_text(request.task_summary).text,
        groups=[
            {
                "name": group["name"],
                "description": sanitize_text(group["description"]).text,
            }
            for group in request.groups
        ],
    )


def build_group_classification_prompt(request: GroupClassificationRequest) -> str:
    request = _safe_request(request)
    payload = {
        "preference_text": request.preference_text,
        "task_summary": request.task_summary,
        "touched_paths": list(request.touched_paths),
        "groups": [
            {"name": group["name"], "description": group["description"]}
            for group in request.groups
        ],
    }
    return (
        f"You classify a personal preference into one existing preference group. Prompt version: {PROMPT_VERSION}.\n"
        "Judge the preference meaning using only the supplied group names and descriptions. "
        "Do not use any other group data, invent a group, or return any field other than group. "
        "Return only JSON in the form {\"group\": \"existing-name\"}.\n\n"
        + stable_json_dumps(payload)
    )


def parse_group_classification_response(
    value: Any,
    request: GroupClassificationRequest,
) -> GroupClassificationResult:
    if isinstance(value, str):
        if len(value.encode("utf-8")) > MAX_RESPONSE_BYTES:
            raise PreferenceEvolutionError("group classifier response exceeded 512 KiB")
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise PreferenceEvolutionError(f"group classifier returned invalid JSON: {exc}") from exc
    try:
        return GroupClassificationResult.from_dict(
            value,
            [group["name"] for group in request.groups],
        )
    except PreferenceContractError as exc:
        raise PreferenceEvolutionError(str(exc)) from exc


def classify_group(
    config: PreferenceConfig,
    request: GroupClassificationRequest,
    model_response: Any | None = None,
    diagnostics: list[str] | None = None,
) -> GroupClassificationResult:
    """Select exactly one group from the request's existing groups."""

    try:
        validated = GroupClassificationRequest.from_dict(request.to_dict())
        if model_response is not None:
            raw_response = model_response
        elif config.provider["name"] == "fake":
            fixture = os.environ.get("PREFERENCE_MODEL_GROUP_RESPONSE")
            if fixture is None:
                raise PreferenceEvolutionError("PREFERENCE_MODEL_GROUP_RESPONSE is required for the fake provider")
            if len(fixture.encode("utf-8")) > MAX_RESPONSE_BYTES:
                raise PreferenceEvolutionError("group classification fixture exceeded 512 KiB")
            raw_response = fixture
        else:
            raw_response = call_openai_compatible(config, build_group_classification_prompt(validated))
        return parse_group_classification_response(raw_response, validated)
    except Exception as exc:
        if diagnostics is not None:
            diagnostics.append(sanitize_text(str(exc)).text[:500])
        raise
