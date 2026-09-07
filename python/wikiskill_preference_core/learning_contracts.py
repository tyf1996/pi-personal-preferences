"""Versioned contracts shared by the preference-learning internal APIs."""

from __future__ import annotations

import copy
import math
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Mapping

from .contracts import stable_hash
from .errors import PreferenceContractError
from .sanitizing import safe_relative_project_path, sanitize_text

COMMAND_ENVELOPE_SCHEMA_VERSION = 2
FEEDBACK_JOB_SCHEMA_VERSION = 1
EVIDENCE_REVISION_SCHEMA_VERSION = 1
PROPOSAL_SCHEMA_VERSION = 1
CAS_SCHEMA_VERSION = 1

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
JOB_STATES = {
    "queued", "running", "completed", "needs_review", "retry_wait",
    "blocked_config", "blocked_model", "blocked_consent", "blocked_budget",
    "failed", "cancelled",
}
EVIDENCE_OPERATIONS = {"upsert", "withdraw", "restore"}
EVIDENCE_NATURES = {"preference", "factual_correction", "task_specific", "unknown"}
EVIDENCE_SPECIFICITIES = {"specific", "generic"}
PROPOSAL_STATES = {"pending_review", "deferred", "rejected", "applied", "stale", "blocked"}
PROPOSAL_ACTIONS = {"add", "replace", "delete", "noop"}


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or isinstance(value, list):
        raise PreferenceContractError(f"{label} must be an object")
    return dict(value)


def _strict(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    data = _object(value, label)
    missing = keys - set(data)
    unknown = set(data) - keys
    if missing:
        raise PreferenceContractError(f"{label} missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceContractError(f"{label} unknown keys: {sorted(map(str, unknown))}")
    return data


def _id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise PreferenceContractError(f"{label} must be a path-safe identifier")
    return value


def _generation(value: Any, label: str = "generation") -> int:
    if type(value) is not int or value < 0:
        raise PreferenceContractError(f"{label} must be a non-negative integer")
    return value


def _digest(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _DIGEST_RE.fullmatch(value):
        raise PreferenceContractError(f"{label} must be a sha256 digest reference")
    return value


def _timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise PreferenceContractError(f"{label} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PreferenceContractError(f"{label} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PreferenceContractError(f"{label} must include a timezone")
    return value


def _text(value: Any, label: str, *, max_length: int, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.strip():
        raise PreferenceContractError(f"{label} must be a non-empty string")
    if len(value) > max_length:
        raise PreferenceContractError(f"{label} exceeds {max_length} characters")
    if any(ord(char) < 32 and char not in "\n\t" for char in value):
        raise PreferenceContractError(f"{label} contains a control character")
    return value


def _clean_text(value: Any, label: str, *, max_length: int, nullable: bool = False) -> str | None:
    result = _text(value, label, max_length=max_length, nullable=nullable)
    if result is not None and sanitize_text(result).changed:
        raise PreferenceContractError(f"{label} contains sensitive data or an absolute path")
    return result


def _nullable_id(value: Any, label: str) -> str | None:
    return None if value is None else _id(value, label)


def _nullable_timestamp(value: Any, label: str) -> str | None:
    return None if value is None else _timestamp(value, label)


@dataclass(frozen=True)
class CasState:
    resource: str
    generation: int
    digest: str

    @classmethod
    def from_dict(cls, value: Any) -> "CasState":
        data = _strict(value, {"schema_version", "resource", "generation", "digest"}, "CAS state")
        if data["schema_version"] != CAS_SCHEMA_VERSION:
            raise PreferenceContractError("CAS schema_version must be 1")
        return cls(
            _id(data["resource"], "cas.resource"),
            _generation(data["generation"], "cas.generation"),
            _digest(data["digest"], "cas.digest"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": CAS_SCHEMA_VERSION,
            "resource": self.resource,
            "generation": self.generation,
            "digest": self.digest,
        }


@dataclass(frozen=True)
class CommandRequest:
    request_id: str
    action: str
    expected_generation: int | None
    payload: dict[str, Any]

    @classmethod
    def from_dict(cls, value: Any) -> "CommandRequest":
        data = _strict(
            value,
            {"schema_version", "request_id", "action", "expected_generation", "payload"},
            "v2 command request",
        )
        if data["schema_version"] != COMMAND_ENVELOPE_SCHEMA_VERSION:
            raise PreferenceContractError("command schema_version must be 2")
        expected = data["expected_generation"]
        if expected is not None:
            expected = _generation(expected, "expected_generation")
        return cls(
            _id(data["request_id"], "request_id"),
            _id(data["action"], "action"),
            expected,
            _object(data["payload"], "payload"),
        )


def success_envelope(
    request_id: str,
    data: Mapping[str, Any],
    *,
    cas: CasState | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": COMMAND_ENVELOPE_SCHEMA_VERSION,
        "request_id": _id(request_id, "request_id"),
        "ok": True,
        "data": dict(data),
        "error": None,
        "cas": cas.to_dict() if cas is not None else None,
    }


def error_envelope(
    request_id: str,
    *,
    code: str,
    message: str,
    retryable: bool = False,
    cas: CasState | None = None,
) -> dict[str, Any]:
    if not isinstance(retryable, bool):
        raise PreferenceContractError("error.retryable must be a boolean")
    return {
        "schema_version": COMMAND_ENVELOPE_SCHEMA_VERSION,
        "request_id": _id(request_id, "request_id"),
        "ok": False,
        "data": None,
        "error": {
            "code": _id(code, "error.code"),
            "message": _text(message, "error.message", max_length=500),
            "retryable": retryable,
        },
        "cas": cas.to_dict() if cas is not None else None,
    }


def model_usage(value: Any, selection: Mapping[str, Any], label: str = "model usage") -> dict[str, Any]:
    data = _strict(value, {
        "known", "input_tokens", "output_tokens", "total_tokens", "cost_usd", "cost_status",
        "provider_id", "model_id", "max_tokens",
    }, label)
    if not isinstance(data["known"], bool):
        raise PreferenceContractError(f"{label}.known must be boolean")
    for key in ("input_tokens", "output_tokens", "total_tokens"):
        token = data[key]
        if data["known"]:
            if type(token) is not int or token < 0:
                raise PreferenceContractError(f"{label}.{key} must be a non-negative integer")
        elif token is not None:
            raise PreferenceContractError(f"{label}.{key} must be null when usage is unknown")
    if data["cost_status"] not in {"known", "unknown"}:
        raise PreferenceContractError(f"{label}.cost_status is invalid")
    cost = data["cost_usd"]
    if data["cost_status"] == "known":
        if isinstance(cost, bool) or not isinstance(cost, (int, float)) or not math.isfinite(float(cost)) or float(cost) < 0:
            raise PreferenceContractError(f"{label}.cost_usd must be a finite non-negative number")
    elif cost is not None:
        raise PreferenceContractError(f"{label}.cost_usd must be null when cost is unknown")
    if data["provider_id"] != selection.get("provider_id") or data["model_id"] != selection.get("model_id"):
        raise PreferenceContractError(f"{label} model metadata does not match the frozen selection")
    if data["max_tokens"] != selection.get("max_tokens"):
        raise PreferenceContractError(f"{label}.max_tokens does not match the frozen limit")
    return copy.deepcopy(data)


def validate_response_envelope(value: Any) -> dict[str, Any]:
    data = _strict(
        value,
        {"schema_version", "request_id", "ok", "data", "error", "cas"},
        "v2 command response",
    )
    if data["schema_version"] != COMMAND_ENVELOPE_SCHEMA_VERSION:
        raise PreferenceContractError("response schema_version must be 2")
    _id(data["request_id"], "request_id")
    if not isinstance(data["ok"], bool):
        raise PreferenceContractError("response.ok must be a boolean")
    if data["cas"] is not None:
        CasState.from_dict(data["cas"])
    if data["ok"]:
        _object(data["data"], "response.data")
        if data["error"] is not None:
            raise PreferenceContractError("successful response.error must be null")
    else:
        if data["data"] is not None:
            raise PreferenceContractError("failed response.data must be null")
        error = _strict(data["error"], {"code", "message", "retryable"}, "response.error")
        _id(error["code"], "error.code")
        _text(error["message"], "error.message", max_length=500)
        if not isinstance(error["retryable"], bool):
            raise PreferenceContractError("error.retryable must be a boolean")
    return data


@dataclass(frozen=True)
class FeedbackJob:
    value: dict[str, Any]

    @classmethod
    def from_dict(cls, value: Any) -> "FeedbackJob":
        keys = {
            "schema_version", "job_id", "generation", "request_id", "created_at", "updated_at",
            "state", "source_kind", "feedback", "group_id", "snapshot_ref", "snapshot_digest",
            "source_context", "model_selection", "consent_revision", "input_digest", "attempts", "next_attempt_at",
            "lease", "result_ref", "error_code", "usage",
        }
        data = _strict(value, keys, "feedback job")
        if data["schema_version"] != FEEDBACK_JOB_SCHEMA_VERSION:
            raise PreferenceContractError("feedback job schema_version must be 1")
        _id(data["job_id"], "job.job_id")
        _generation(data["generation"], "job.generation")
        _id(data["request_id"], "job.request_id")
        _timestamp(data["created_at"], "job.created_at")
        _timestamp(data["updated_at"], "job.updated_at")
        if data["state"] not in JOB_STATES:
            raise PreferenceContractError(f"job.state is unsupported: {data['state']!r}")
        if data["source_kind"] not in {"feedback", "user_edit"}:
            raise PreferenceContractError(f"job.source_kind is unsupported: {data['source_kind']!r}")
        _text(data["feedback"], "job.feedback", max_length=2000)
        _nullable_id(data["group_id"], "job.group_id")
        _nullable_id(data["snapshot_ref"], "job.snapshot_ref")
        if data["snapshot_digest"] is not None:
            _digest(data["snapshot_digest"], "job.snapshot_digest")
        source_context = data["source_context"]
        if data["source_kind"] == "feedback":
            if source_context is not None:
                raise PreferenceContractError("explicit feedback must not contain user-edit source context")
        else:
            source_context = _strict(
                source_context,
                {"task_key", "task_summary", "paths", "diffs", "reason"},
                "job.source_context",
            )
            _id(source_context["task_key"], "job.source_context.task_key")
            _clean_text(source_context["task_summary"], "job.source_context.task_summary", max_length=1000)
            paths = source_context["paths"]
            if not isinstance(paths, list) or not paths or len(paths) > 32:
                raise PreferenceContractError("job.source_context.paths must contain one to 32 paths")
            normalized_paths = [safe_relative_project_path(item) for item in paths]
            if len(normalized_paths) != len(set(normalized_paths)):
                raise PreferenceContractError("job.source_context.paths must not contain duplicates")
            diffs = source_context["diffs"]
            if not isinstance(diffs, Mapping) or isinstance(diffs, list) or set(diffs) - set(normalized_paths):
                raise PreferenceContractError("job.source_context.diffs must be keyed by selected paths")
            for path, diff in diffs.items():
                _clean_text(diff, f"job.source_context.diffs[{path}]", max_length=32768)
            _clean_text(source_context["reason"], "job.source_context.reason", max_length=2000, nullable=True)
            if data["snapshot_ref"] is not None or data["snapshot_digest"] is not None or data["model_selection"] is not None:
                raise PreferenceContractError("user-edit jobs cannot contain a snapshot or model binding")
            if data["consent_revision"] != 0 or data["state"] != "needs_review":
                raise PreferenceContractError("user-edit jobs must remain local needs-review records")
        model = data["model_selection"]
        if model is not None:
            model = _strict(
                model,
                {
                    "provider_source", "provider_id", "model_id", "api_type", "endpoint_fingerprint",
                    "thinking_level", "max_tokens", "timeout_seconds", "config_version",
                },
                "job.model_selection",
            )
            if model["provider_source"] not in {"pi", "custom", "fake"}:
                raise PreferenceContractError("job.model_selection.provider_source is unsupported")
            _text(model["provider_id"], "job.model_selection.provider_id", max_length=128)
            _text(model["model_id"], "job.model_selection.model_id", max_length=256)
            if model["api_type"] not in {"pi", "openai_compatible", "fake"}:
                raise PreferenceContractError("job.model_selection.api_type is unsupported")
            _digest(model["endpoint_fingerprint"], "job.model_selection.endpoint_fingerprint")
            if model["thinking_level"] not in {"off", "minimal", "low", "medium", "high", "xhigh", "max"}:
                raise PreferenceContractError("job.model_selection.thinking_level is unsupported")
            if type(model["max_tokens"]) is not int or model["max_tokens"] < 1:
                raise PreferenceContractError("job.model_selection.max_tokens must be a positive integer")
            timeout = model["timeout_seconds"]
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)):
                raise PreferenceContractError("job.model_selection.timeout_seconds must be numeric")
            if not math.isfinite(float(timeout)) or not 0 < float(timeout) <= 1800:
                raise PreferenceContractError("job.model_selection.timeout_seconds must be within 0..1800")
            _generation(model["config_version"], "job.model_selection.config_version")
        elif data["state"] in {"queued", "running", "retry_wait"}:
            raise PreferenceContractError("dispatchable feedback jobs require a frozen model selection")
        if data["usage"] is not None:
            if model is None:
                raise PreferenceContractError("feedback usage requires a frozen model selection")
            model_usage(data["usage"], model, "job.usage")
        _generation(data["consent_revision"], "job.consent_revision")
        _digest(data["input_digest"], "job.input_digest")
        _generation(data["attempts"], "job.attempts")
        _nullable_timestamp(data["next_attempt_at"], "job.next_attempt_at")
        if data["lease"] is not None:
            lease = _strict(
                data["lease"],
                {"token", "owner_id", "job_id", "generation", "expires_at", "renewed_at"},
                "job.lease",
            )
            _id(lease["token"], "job.lease.token")
            _id(lease["owner_id"], "job.lease.owner_id")
            if _id(lease["job_id"], "job.lease.job_id") != data["job_id"]:
                raise PreferenceContractError("job.lease.job_id must match job.job_id")
            if _generation(lease["generation"], "job.lease.generation") != data["generation"]:
                raise PreferenceContractError("job.lease.generation must match job.generation")
            _timestamp(lease["expires_at"], "job.lease.expires_at")
            _timestamp(lease["renewed_at"], "job.lease.renewed_at")
            if data["state"] != "running":
                raise PreferenceContractError("only a running job may have a lease")
        elif data["state"] == "running":
            raise PreferenceContractError("a running job requires a lease")
        _nullable_id(data["result_ref"], "job.result_ref")
        if data["error_code"] is not None:
            _id(data["error_code"], "job.error_code")
        return cls(copy.deepcopy(data))

    def to_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self.value)


@dataclass(frozen=True)
class EvidenceRevision:
    value: dict[str, Any]

    @classmethod
    def from_dict(cls, value: Any) -> "EvidenceRevision":
        keys = {
            "schema_version", "evidence_id", "revision_id", "parents", "operation", "recorded_at",
            "author_kind", "origin_task_key", "origin_verified", "feedback_id", "group_id", "content",
        }
        data = _strict(value, keys, "evidence revision")
        if data["schema_version"] != EVIDENCE_REVISION_SCHEMA_VERSION:
            raise PreferenceContractError("evidence revision schema_version must be 1")
        _id(data["evidence_id"], "evidence.evidence_id")
        _id(data["revision_id"], "evidence.revision_id")
        if not isinstance(data["parents"], list):
            raise PreferenceContractError("evidence.parents must be a list")
        parents = [_id(item, "evidence.parents item") for item in data["parents"]]
        if len(parents) != len(set(parents)):
            raise PreferenceContractError("evidence.parents must not contain duplicates")
        if data["revision_id"] in parents:
            raise PreferenceContractError("evidence revision cannot parent itself")
        if data["operation"] not in EVIDENCE_OPERATIONS:
            raise PreferenceContractError(f"evidence.operation is unsupported: {data['operation']!r}")
        _timestamp(data["recorded_at"], "evidence.recorded_at")
        if data["author_kind"] not in {"user", "extractor", "host"}:
            raise PreferenceContractError(f"evidence.author_kind is unsupported: {data['author_kind']!r}")
        _id(data["origin_task_key"], "evidence.origin_task_key")
        if not isinstance(data["origin_verified"], bool):
            raise PreferenceContractError("evidence.origin_verified must be a boolean")
        _nullable_id(data["feedback_id"], "evidence.feedback_id")
        _nullable_id(data["group_id"], "evidence.group_id")
        content = data["content"]
        if data["operation"] == "withdraw":
            if content is not None:
                raise PreferenceContractError("withdraw evidence content must be null")
        else:
            content_data = _strict(
                content,
                {
                    "raw_feedback", "feedback_created_at", "task_summary", "evidence_summary",
                    "feedback_target", "observations", "actual_behavior", "expected_behavior",
                    "applicability", "nature", "specificity", "confidence", "needs_review",
                    "context_completeness", "sanitizer_version", "extractor_prompt_version",
                },
                "evidence.content",
            )
            _clean_text(content_data["raw_feedback"], "evidence.content.raw_feedback", max_length=2000)
            _timestamp(content_data["feedback_created_at"], "evidence.content.feedback_created_at")
            target = _strict(
                content_data["feedback_target"],
                {"type", "description", "quote"},
                "evidence.content.feedback_target",
            )
            _clean_text(target["type"], "evidence.content.feedback_target.type", max_length=64)
            _clean_text(target["description"], "evidence.content.feedback_target.description", max_length=1000)
            quote = target["quote"]
            if quote is not None:
                quote = _strict(quote, {"source_alias", "text"}, "evidence.content.feedback_target.quote")
                if quote["source_alias"] not in {"task_request", "assistant_result", "user_selected_diff", "feedback"}:
                    raise PreferenceContractError("evidence.content.feedback_target.quote.source_alias is unsupported")
                _clean_text(quote["text"], "evidence.content.feedback_target.quote.text", max_length=1000)
            if not isinstance(content_data["observations"], list) or not 1 <= len(content_data["observations"]) <= 5:
                raise PreferenceContractError("evidence.content.observations must contain one to five observations")
            for observation in content_data["observations"]:
                _clean_text(observation, "evidence.content.observation", max_length=1000)
            _clean_text(content_data["actual_behavior"], "evidence.content.actual_behavior", max_length=4000, nullable=True)
            _clean_text(content_data["expected_behavior"], "evidence.content.expected_behavior", max_length=4000, nullable=True)
            for key in ("task_summary", "evidence_summary", "applicability"):
                _clean_text(content_data[key], f"evidence.content.{key}", max_length=4000)
            if content_data["nature"] not in EVIDENCE_NATURES:
                raise PreferenceContractError("evidence.content.nature is unsupported")
            if content_data["specificity"] not in EVIDENCE_SPECIFICITIES:
                raise PreferenceContractError("evidence.content.specificity is unsupported")
            confidence = content_data["confidence"]
            if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
                raise PreferenceContractError("evidence.content.confidence must be within 0..1")
            if not isinstance(content_data["needs_review"], bool):
                raise PreferenceContractError("evidence.content.needs_review must be a boolean")
            if float(confidence) < 0.7 and not content_data["needs_review"]:
                raise PreferenceContractError("weak evidence must require review")
            if content_data["context_completeness"] not in {"complete", "partial", "missing"}:
                raise PreferenceContractError("evidence.content.context_completeness is unsupported")
            _id(content_data["sanitizer_version"], "evidence.content.sanitizer_version")
            _id(content_data["extractor_prompt_version"], "evidence.content.extractor_prompt_version")
        return cls(copy.deepcopy(data))

    def to_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self.value)


def _evidence_ref(value: Any, label: str) -> dict[str, str]:
    data = _strict(value, {"evidence_id", "revision_id"}, label)
    return {
        "evidence_id": _id(data["evidence_id"], f"{label}.evidence_id"),
        "revision_id": _id(data["revision_id"], f"{label}.revision_id"),
    }


@dataclass(frozen=True)
class Change:
    value: dict[str, Any]

    @classmethod
    def from_dict(cls, value: Any) -> "Change":
        data = _strict(value, {
            "change_id", "action", "state", "rule_ref", "proposed_text", "evidence_refs",
            "opposing_evidence_refs", "rationale", "applicability", "uncertainty",
            "old_rule_problem", "gate_result", "review",
        }, "proposal change")
        _id(data["change_id"], "change.change_id")
        if data["action"] not in PROPOSAL_ACTIONS:
            raise PreferenceContractError("proposal change action is unsupported")
        if data["state"] not in PROPOSAL_STATES:
            raise PreferenceContractError("proposal change state is unsupported")
        if data["rule_ref"] is not None:
            rule_ref = _strict(data["rule_ref"], {"rule_id", "revision", "text", "digest"}, "change.rule_ref")
            _id(rule_ref["rule_id"], "change.rule_ref.rule_id")
            if _generation(rule_ref["revision"], "change.rule_ref.revision") < 1:
                raise PreferenceContractError("change rule revision must be positive")
            _clean_text(rule_ref["text"], "change.rule_ref.text", max_length=1000)
            _digest(rule_ref["digest"], "change.rule_ref.digest")
        if data["action"] in {"replace", "delete"} and data["rule_ref"] is None:
            raise PreferenceContractError("replace/delete changes require an exact rule_ref")
        if data["action"] in {"add", "noop"} and data["rule_ref"] is not None:
            raise PreferenceContractError("add/noop changes cannot contain rule_ref")
        proposed = _clean_text(data["proposed_text"], "change.proposed_text", max_length=1000, nullable=True)
        if data["action"] in {"add", "replace"} and proposed is None:
            raise PreferenceContractError("add/replace changes require proposed_text")
        if data["action"] in {"delete", "noop"} and proposed is not None:
            raise PreferenceContractError("delete/noop changes cannot contain proposed_text")
        for key in ("evidence_refs", "opposing_evidence_refs"):
            refs = data[key]
            if not isinstance(refs, list):
                raise PreferenceContractError(f"change.{key} must be a list")
            normalized = [_evidence_ref(item, f"change.{key} item") for item in refs]
            pairs = [(item["evidence_id"], item["revision_id"]) for item in normalized]
            if len(pairs) != len(set(pairs)):
                raise PreferenceContractError(f"change.{key} must not contain duplicates")
        for key in ("rationale", "applicability"):
            _clean_text(data[key], f"change.{key}", max_length=4000)
        _clean_text(data["uncertainty"], "change.uncertainty", max_length=4000, nullable=True)
        _clean_text(data["old_rule_problem"], "change.old_rule_problem", max_length=4000, nullable=True)
        gate = _strict(data["gate_result"], {
            "classification", "reasons", "support_task_count", "opposition_task_count",
            "explicit_opposition_count", "evidence_fingerprint",
        }, "change.gate_result")
        if gate["classification"] not in {"eligible_for_review", "insufficient_evidence", "needs_review", "invalid"}:
            raise PreferenceContractError("change gate classification is unsupported")
        if not isinstance(gate["reasons"], list) or any(not isinstance(item, str) or not item for item in gate["reasons"]):
            raise PreferenceContractError("change gate reasons must be non-empty strings")
        for key in ("support_task_count", "opposition_task_count", "explicit_opposition_count"):
            _generation(gate[key], f"change.gate_result.{key}")
        _digest(gate["evidence_fingerprint"], "change.gate_result.evidence_fingerprint")
        review = data["review"]
        if review is not None:
            review = _strict(review, {"decision", "decided_at", "final_text", "reason", "operation_id"}, "change.review")
            if review["decision"] not in {"accepted", "accepted_with_edits", "rejected", "deferred"}:
                raise PreferenceContractError("change review decision is unsupported")
            _timestamp(review["decided_at"], "change.review.decided_at")
            _clean_text(review["final_text"], "change.review.final_text", max_length=1000, nullable=True)
            _clean_text(review["reason"], "change.review.reason", max_length=2000, nullable=True)
            _nullable_id(review["operation_id"], "change.review.operation_id")
        return cls(copy.deepcopy(data))

    def to_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self.value)


@dataclass(frozen=True)
class ProposalJob:
    value: dict[str, Any]

    @classmethod
    def from_dict(cls, value: Any) -> "ProposalJob":
        data = _strict(value, {
            "schema_version", "job_id", "generation", "request_id", "created_at", "updated_at",
            "state", "group_id", "model_selection", "authorization_revision", "input_signature",
            "input_digest", "attempts", "next_attempt_at", "lease", "result_ref", "error_code", "usage",
        }, "proposal job")
        if data["schema_version"] != 1:
            raise PreferenceContractError("proposal job schema_version must be 1")
        _id(data["job_id"], "proposal_job.job_id")
        _generation(data["generation"], "proposal_job.generation")
        _id(data["request_id"], "proposal_job.request_id")
        _timestamp(data["created_at"], "proposal_job.created_at")
        _timestamp(data["updated_at"], "proposal_job.updated_at")
        if data["state"] not in JOB_STATES:
            raise PreferenceContractError("proposal job state is unsupported")
        _id(data["group_id"], "proposal_job.group_id")
        model = data["model_selection"]
        if model is not None:
            model = _strict(model, {
                "provider_source", "provider_id", "model_id", "api_type", "endpoint_fingerprint",
                "thinking_level", "max_tokens", "timeout_seconds", "config_version",
            }, "proposal_job.model_selection")
            if model["provider_source"] not in {"pi", "custom", "fake"} or model["api_type"] not in {"pi", "openai_compatible", "fake"}:
                raise PreferenceContractError("proposal job model selection is unsupported")
            _text(model["provider_id"], "proposal_job.model_selection.provider_id", max_length=128)
            _text(model["model_id"], "proposal_job.model_selection.model_id", max_length=256)
            _digest(model["endpoint_fingerprint"], "proposal_job.model_selection.endpoint_fingerprint")
            if model["thinking_level"] not in {"off", "minimal", "low", "medium", "high", "xhigh", "max"}:
                raise PreferenceContractError("proposal job thinking level is unsupported")
            if type(model["max_tokens"]) is not int or model["max_tokens"] < 1:
                raise PreferenceContractError("proposal job max_tokens must be positive")
            timeout = model["timeout_seconds"]
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(float(timeout)) or not 0 < float(timeout) <= 1800:
                raise PreferenceContractError("proposal job timeout is invalid")
            _generation(model["config_version"], "proposal_job.model_selection.config_version")
        elif data["state"] in {"queued", "running", "retry_wait"}:
            raise PreferenceContractError("dispatchable proposal jobs require a frozen model selection")
        if data["usage"] is not None:
            if model is None:
                raise PreferenceContractError("proposal usage requires a frozen model selection")
            model_usage(data["usage"], model, "proposal_job.usage")
        _generation(data["authorization_revision"], "proposal_job.authorization_revision")
        _digest(data["input_signature"], "proposal_job.input_signature")
        _digest(data["input_digest"], "proposal_job.input_digest")
        _generation(data["attempts"], "proposal_job.attempts")
        _nullable_timestamp(data["next_attempt_at"], "proposal_job.next_attempt_at")
        if data["lease"] is not None:
            lease = _strict(data["lease"], {"token", "owner_id", "job_id", "generation", "expires_at", "renewed_at"}, "proposal_job.lease")
            _id(lease["token"], "proposal_job.lease.token")
            _id(lease["owner_id"], "proposal_job.lease.owner_id")
            if _id(lease["job_id"], "proposal_job.lease.job_id") != data["job_id"]:
                raise PreferenceContractError("proposal job lease ID mismatch")
            if _generation(lease["generation"], "proposal_job.lease.generation") != data["generation"]:
                raise PreferenceContractError("proposal job lease generation mismatch")
            _timestamp(lease["expires_at"], "proposal_job.lease.expires_at")
            _timestamp(lease["renewed_at"], "proposal_job.lease.renewed_at")
            if data["state"] != "running":
                raise PreferenceContractError("only a running proposal job may have a lease")
        elif data["state"] == "running":
            raise PreferenceContractError("a running proposal job requires a lease")
        _nullable_id(data["result_ref"], "proposal_job.result_ref")
        if data["error_code"] is not None:
            _id(data["error_code"], "proposal_job.error_code")
        return cls(copy.deepcopy(data))

    def to_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self.value)


@dataclass(frozen=True)
class Proposal:
    value: dict[str, Any]

    @classmethod
    def from_dict(cls, value: Any) -> "Proposal":
        data = _strict(value, {
            "schema_version", "proposal_id", "generation", "created_at", "updated_at", "job_id",
            "model_selection", "prompt_version", "gate_version", "input_signature", "group_id",
            "base_group_digest", "base_group_revision", "base_rule_refs", "evidence_refs",
            "evidence_heads", "evidence_view_digest", "decision_digest", "coverage", "changes",
            "rationale", "state",
        }, "proposal")
        if data["schema_version"] != PROPOSAL_SCHEMA_VERSION:
            raise PreferenceContractError("proposal schema_version must be 1")
        _id(data["proposal_id"], "proposal.proposal_id")
        _generation(data["generation"], "proposal.generation")
        _timestamp(data["created_at"], "proposal.created_at")
        _timestamp(data["updated_at"], "proposal.updated_at")
        _id(data["job_id"], "proposal.job_id")
        ProposalJob.from_dict({
            "schema_version": 1, "job_id": data["job_id"], "generation": 0, "request_id": "proposal-probe",
            "created_at": data["created_at"], "updated_at": data["updated_at"], "state": "completed",
            "group_id": data["group_id"], "model_selection": data["model_selection"], "authorization_revision": 0,
            "input_signature": data["input_signature"], "input_digest": data["input_signature"], "attempts": 0,
            "next_attempt_at": None, "lease": None, "result_ref": data["proposal_id"], "error_code": None,
            "usage": None,
        })
        _id(data["prompt_version"], "proposal.prompt_version")
        _id(data["gate_version"], "proposal.gate_version")
        _digest(data["input_signature"], "proposal.input_signature")
        _id(data["group_id"], "proposal.group_id")
        _digest(data["base_group_digest"], "proposal.base_group_digest")
        if _generation(data["base_group_revision"], "proposal.base_group_revision") < 1:
            raise PreferenceContractError("proposal base_group_revision must be positive")
        if not isinstance(data["base_rule_refs"], list):
            raise PreferenceContractError("proposal.base_rule_refs must be a list")
        for item in data["base_rule_refs"]:
            ref = _strict(item, {"rule_id", "revision", "text", "digest"}, "proposal base rule reference")
            _id(ref["rule_id"], "proposal.base_rule_refs.rule_id")
            if _generation(ref["revision"], "proposal.base_rule_refs.revision") < 1:
                raise PreferenceContractError("proposal base rule revision must be positive")
            _clean_text(ref["text"], "proposal.base_rule_refs.text", max_length=1000)
            _digest(ref["digest"], "proposal.base_rule_refs.digest")
        if not isinstance(data["evidence_refs"], list):
            raise PreferenceContractError("proposal.evidence_refs must be a list")
        for item in data["evidence_refs"]:
            _evidence_ref(item, "proposal evidence reference")
        if not isinstance(data["evidence_heads"], list):
            raise PreferenceContractError("proposal.evidence_heads must be a list")
        for item in data["evidence_heads"]:
            head = _strict(item, {"evidence_id", "heads", "status"}, "proposal evidence head")
            _id(head["evidence_id"], "proposal.evidence_heads.evidence_id")
            if not isinstance(head["heads"], list):
                raise PreferenceContractError("proposal evidence heads are invalid")
            checked_heads = [_id(value, "proposal.evidence_heads.head") for value in head["heads"]]
            if len(checked_heads) != len(set(checked_heads)):
                raise PreferenceContractError("proposal evidence heads must not contain duplicates")
            if head["status"] not in {"active", "withdrawn", "conflict", "orphaned_group"}:
                raise PreferenceContractError("proposal evidence status is invalid")
        _digest(data["evidence_view_digest"], "proposal.evidence_view_digest")
        _digest(data["decision_digest"], "proposal.decision_digest")
        coverage = _strict(data["coverage"], {
            "status", "available_evidence_count", "included_evidence_count", "omitted_evidence_count",
            "byte_budget", "included_bytes", "reasons", "missing_rule_source_refs",
        }, "proposal.coverage")
        if coverage["status"] not in {"complete", "partial"}:
            raise PreferenceContractError("proposal coverage status is unsupported")
        for key in ("available_evidence_count", "included_evidence_count", "omitted_evidence_count", "byte_budget", "included_bytes"):
            _generation(coverage[key], f"proposal.coverage.{key}")
        if not isinstance(coverage["reasons"], list) or any(not isinstance(item, str) or not item for item in coverage["reasons"]):
            raise PreferenceContractError("proposal coverage reasons are invalid")
        if not isinstance(coverage["missing_rule_source_refs"], list) or any(not isinstance(item, str) for item in coverage["missing_rule_source_refs"]):
            raise PreferenceContractError("proposal missing source refs are invalid")
        if not isinstance(data["changes"], list) or not 1 <= len(data["changes"]) <= 3:
            raise PreferenceContractError("proposal.changes must contain one to three changes")
        changes = [Change.from_dict(item).to_dict() for item in data["changes"]]
        if len({item["change_id"] for item in changes}) != len(changes):
            raise PreferenceContractError("proposal change IDs must be unique")
        _clean_text(data["rationale"], "proposal.rationale", max_length=8000)
        if data["state"] not in PROPOSAL_STATES:
            raise PreferenceContractError("proposal.state is unsupported")
        return cls(copy.deepcopy(data))

    def to_dict(self) -> dict[str, Any]:
        return copy.deepcopy(self.value)


def cas_for(resource: str, generation: int, value: Any) -> CasState:
    return CasState(resource, generation, f"sha256:{stable_hash(value)}")
