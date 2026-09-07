"""Small, strict storage layer for groups, activations, feedback, and evidence."""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import secrets
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .errors import PreferenceIntegrityError, PreferenceValidationError

GROUPS_SCHEMA_VERSION = 2
ACTIVATIONS_SCHEMA_VERSION = 2
LEARNING_SCHEMA_VERSION = 1
MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
MAX_SELECTED_TEXT_CHARACTERS = 4 * 1024 * 1024
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_CREDENTIAL_PATTERNS = (
    re.compile(r"-----BEGIN [\s\S]*?PRIVATE KEY-----[\s\S]*?-----END [\s\S]*?PRIVATE KEY-----", re.I),
    re.compile(r"\b(?:sk|gh[pousr])_[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\b(?:api[_-]?key|access[_-]?token|password|authorization)\b\s*[:=]\s*\S+", re.I),
)


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return f"sha256:{hashlib.sha256(stable_json(value).encode('utf-8')).hexdigest()}"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}{secrets.token_hex(16)}"


def redact_sensitive(value: str) -> str:
    result = value
    for pattern in _CREDENTIAL_PATTERNS:
        result = pattern.sub("[REDACTED_CREDENTIAL]", result)
    return result


def checked_text(value: Any, label: str, *, maximum: int, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise PreferenceValidationError(f"{label} must be a string")
    result = redact_sensitive(value).strip()
    if not allow_empty and not result:
        raise PreferenceValidationError(f"{label} must not be empty")
    if len(result) > maximum:
        raise PreferenceValidationError(f"{label} exceeds {maximum} characters")
    if any(ord(char) < 32 and char not in "\n\t" for char in result):
        raise PreferenceValidationError(f"{label} contains a control character")
    return result


def checked_id(value: Any, label: str) -> str:
    result = checked_text(value, label, maximum=128)
    if not _ID_RE.fullmatch(result):
        raise PreferenceValidationError(f"{label} is not a safe identifier")
    return result


def _safe_dir(path: Path) -> None:
    if path.is_symlink():
        raise PreferenceIntegrityError(f"symlink directory is not allowed: {path}")
    if path.exists() and not path.is_dir():
        raise PreferenceIntegrityError(f"expected directory: {path}")
    path.mkdir(parents=True, exist_ok=True)


def _safe_file(path: Path, *, missing: bool = False) -> None:
    if path.is_symlink():
        raise PreferenceIntegrityError(f"symlink file is not allowed: {path}")
    if not path.exists():
        if missing:
            return
        raise PreferenceIntegrityError(f"file does not exist: {path}")
    if not path.is_file():
        raise PreferenceIntegrityError(f"expected regular file: {path}")


def atomic_write(path: Path, value: Any) -> None:
    _safe_dir(path.parent)
    _safe_file(path, missing=True)
    payload = (stable_json(value) + "\n").encode("utf-8")
    if len(payload) > MAX_DOCUMENT_BYTES:
        raise PreferenceValidationError(f"document exceeds {MAX_DOCUMENT_BYTES} bytes: {path.name}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        try:
            directory_fd = os.open(path.parent, os.O_DIRECTORY)
        except (AttributeError, OSError):
            directory_fd = -1
        if directory_fd >= 0:
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise PreferenceIntegrityError(f"cannot atomically write {path}: {exc}") from exc


def read_json(path: Path, label: str) -> Any:
    _safe_file(path)
    if path.stat().st_size > MAX_DOCUMENT_BYTES:
        raise PreferenceIntegrityError(f"{label} exceeds {MAX_DOCUMENT_BYTES} bytes")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreferenceIntegrityError(f"cannot read {label}: {exc}") from exc


def _strict_object(value: Any, required: set[str], allowed: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PreferenceValidationError(f"{label} must be an object")
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise PreferenceValidationError(f"{label} missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceValidationError(f"{label} unknown keys: {sorted(unknown)}")
    return dict(value)


def validate_rule(value: Any) -> dict[str, Any]:
    data = _strict_object(value, {"id", "revision", "text", "enabled"}, {"id", "revision", "text", "enabled"}, "rule")
    rule_id = checked_id(data["id"], "rule.id")
    revision = data["revision"]
    if type(revision) is not int or revision < 1:
        raise PreferenceValidationError("rule.revision must be a positive integer")
    if not isinstance(data["enabled"], bool):
        raise PreferenceValidationError("rule.enabled must be boolean")
    return {
        "id": rule_id,
        "revision": revision,
        "text": checked_text(data["text"], "rule.text", maximum=1000),
        "enabled": data["enabled"],
    }


def validate_group(value: Any) -> dict[str, Any]:
    data = _strict_object(value, {"id", "revision", "name", "description", "rules"}, {"id", "revision", "name", "description", "rules"}, "group")
    revision = data["revision"]
    if type(revision) is not int or revision < 1:
        raise PreferenceValidationError("group.revision must be a positive integer")
    if not isinstance(data["rules"], list):
        raise PreferenceValidationError("group.rules must be a list")
    rules = [validate_rule(item) for item in data["rules"]]
    if len({item["id"] for item in rules}) != len(rules) or len({item["text"] for item in rules}) != len(rules):
        raise PreferenceValidationError("group rules must have unique IDs and text")
    return {
        "id": checked_id(data["id"], "group.id"),
        "revision": revision,
        "name": checked_text(data["name"], "group.name", maximum=128),
        "description": checked_text(data["description"], "group.description", maximum=2000),
        "rules": rules,
    }


def validate_groups_document(value: Any) -> dict[str, Any]:
    data = _strict_object(value, {"schema_version", "groups"}, {"schema_version", "groups"}, "groups document")
    if data["schema_version"] != GROUPS_SCHEMA_VERSION or not isinstance(data["groups"], list):
        raise PreferenceValidationError("groups document must use schema_version=2 and contain a group list")
    groups = [validate_group(item) for item in data["groups"]]
    if len({item["id"] for item in groups}) != len(groups) or len({item["name"] for item in groups}) != len(groups):
        raise PreferenceValidationError("groups must have unique IDs and names")
    all_rule_ids = [rule["id"] for group in groups for rule in group["rules"]]
    if len(all_rule_ids) != len(set(all_rule_ids)):
        raise PreferenceValidationError("rule IDs must be globally unique")
    groups.sort(key=lambda item: (item["name"] != "global", item["name"]))
    return {"schema_version": GROUPS_SCHEMA_VERSION, "groups": groups}


def _activation_map(value: Any, label: str) -> dict[str, list[str]]:
    if not isinstance(value, dict):
        raise PreferenceValidationError(f"{label} must be an object")
    result: dict[str, list[str]] = {}
    for key, raw_ids in value.items():
        clean_key = checked_text(key, f"{label} key", maximum=4096)
        if not isinstance(raw_ids, list):
            raise PreferenceValidationError(f"{label}[{clean_key}] must be a list")
        ids = [checked_id(item, f"{label}[{clean_key}]") for item in raw_ids]
        result[clean_key] = list(dict.fromkeys(ids))
    return result


def validate_activations(value: Any) -> dict[str, Any]:
    data = _strict_object(value, {"schema_version", "directories", "sessions"}, {"schema_version", "directories", "sessions"}, "activations")
    if data["schema_version"] != ACTIVATIONS_SCHEMA_VERSION:
        raise PreferenceValidationError("activations must use schema_version=2")
    return {
        "schema_version": ACTIVATIONS_SCHEMA_VERSION,
        "directories": _activation_map(data["directories"], "activations.directories"),
        "sessions": _activation_map(data["sessions"], "activations.sessions"),
    }


def validate_turn(value: Any, index: int) -> dict[str, str]:
    data = _strict_object(value, {"user", "assistant"}, {"user", "assistant"}, f"selected_turns[{index}]")
    return {
        "user": checked_text(data["user"], f"selected_turns[{index}].user", maximum=MAX_SELECTED_TEXT_CHARACTERS),
        "assistant": checked_text(data["assistant"], f"selected_turns[{index}].assistant", maximum=MAX_SELECTED_TEXT_CHARACTERS),
    }


def validate_model(value: Any) -> dict[str, str]:
    data = _strict_object(value, {"provider", "id", "thinking"}, {"provider", "id", "thinking"}, "model")
    return {
        "provider": checked_text(data["provider"], "model.provider", maximum=128),
        "id": checked_text(data["id"], "model.id", maximum=256),
        "thinking": checked_text(data["thinking"], "model.thinking", maximum=32),
    }


def validate_evidence(value: Any) -> dict[str, Any]:
    allowed = {"summary", "actual_behavior", "expected_behavior", "applicability", "supporting_quotes"}
    data = _strict_object(value, allowed, allowed, "extraction.evidence")
    quotes = data["supporting_quotes"]
    if not isinstance(quotes, list) or not quotes or len(quotes) > 20:
        raise PreferenceValidationError("extraction.evidence.supporting_quotes must contain 1..20 strings")
    return {
        "summary": checked_text(data["summary"], "evidence.summary", maximum=2000),
        "actual_behavior": checked_text(data["actual_behavior"], "evidence.actual_behavior", maximum=4000),
        "expected_behavior": checked_text(data["expected_behavior"], "evidence.expected_behavior", maximum=4000),
        "applicability": checked_text(data["applicability"], "evidence.applicability", maximum=2000),
        "supporting_quotes": [checked_text(item, "evidence.supporting_quote", maximum=2000) for item in quotes],
    }


def validate_proposed_rules(value: Any) -> list[str]:
    if not isinstance(value, list) or len(value) > 200:
        raise PreferenceValidationError("proposed_rules must be a list with at most 200 items")
    result = [checked_text(item, "proposed rule", maximum=1000) for item in value]
    if len(result) != len(set(result)):
        raise PreferenceValidationError("proposed_rules must not contain duplicates")
    return result


def _optional_text(value: Any, label: str, maximum: int) -> str | None:
    return None if value is None else checked_text(value, label, maximum=maximum)


def validate_feedback_record(value: Any) -> dict[str, Any]:
    fields = {"id", "created_at", "sentiment", "reason", "selected_turns", "model", "group_name", "status", "evidence_id", "error"}
    data = _strict_object(value, fields, fields, "stored feedback")
    if data["sentiment"] not in {"good", "fix"} or data["status"] not in {"saved", "pending_group", "organized", "failed"}:
        raise PreferenceIntegrityError("stored feedback state is invalid")
    if not isinstance(data["selected_turns"], list) or not 1 <= len(data["selected_turns"]) <= 10:
        raise PreferenceIntegrityError("stored feedback turns are invalid")
    return {
        "id": checked_id(data["id"], "feedback.id"),
        "created_at": checked_text(data["created_at"], "feedback.created_at", maximum=64),
        "sentiment": data["sentiment"],
        "reason": checked_text(data["reason"], "feedback.reason", maximum=4000),
        "selected_turns": [validate_turn(item, index) for index, item in enumerate(data["selected_turns"])],
        "model": None if data["model"] is None else validate_model(data["model"]),
        "group_name": _optional_text(data["group_name"], "feedback.group_name", 128),
        "status": data["status"],
        "evidence_id": None if data["evidence_id"] is None else checked_id(data["evidence_id"], "feedback.evidence_id"),
        "error": _optional_text(data["error"], "feedback.error", 500),
    }


def validate_evidence_record(value: Any) -> dict[str, Any]:
    fields = {"id", "created_at", "feedback_id", "group_id", "group_name", "summary", "actual_behavior", "expected_behavior", "applicability", "supporting_quotes"}
    data = _strict_object(value, fields, fields, "stored evidence")
    content = validate_evidence({key: data[key] for key in {"summary", "actual_behavior", "expected_behavior", "applicability", "supporting_quotes"}})
    return {
        "id": checked_id(data["id"], "evidence.id"),
        "created_at": checked_text(data["created_at"], "evidence.created_at", maximum=64),
        "feedback_id": checked_id(data["feedback_id"], "evidence.feedback_id"),
        "group_id": checked_id(data["group_id"], "evidence.group_id"),
        "group_name": checked_text(data["group_name"], "evidence.group_name", maximum=128),
        **content,
    }


def validate_proposal_record(value: Any) -> dict[str, Any]:
    fields = {"id", "created_at", "group_id", "group_name", "base_digest", "evidence_ids", "existing_rules", "proposed_rules", "rationale", "status", "resolved_at", "commit"}
    data = _strict_object(value, fields, fields, "stored proposal")
    if data["status"] not in {"pending", "applied", "rejected", "stale"}:
        raise PreferenceIntegrityError("stored proposal status is invalid")
    if not isinstance(data["evidence_ids"], list) or not data["evidence_ids"]:
        raise PreferenceIntegrityError("stored proposal evidence_ids are invalid")
    existing_rules = validate_proposed_rules(data["existing_rules"])
    proposed_rules = validate_proposed_rules(data["proposed_rules"])
    commit = _optional_text(data["commit"], "proposal.commit", 64)
    if commit is not None and not re.fullmatch(r"[0-9a-f]{7,64}", commit):
        raise PreferenceIntegrityError("stored proposal commit is invalid")
    return {
        "id": checked_id(data["id"], "proposal.id"),
        "created_at": checked_text(data["created_at"], "proposal.created_at", maximum=64),
        "group_id": checked_id(data["group_id"], "proposal.group_id"),
        "group_name": checked_text(data["group_name"], "proposal.group_name", maximum=128),
        "base_digest": checked_text(data["base_digest"], "proposal.base_digest", maximum=80),
        "evidence_ids": [checked_id(item, "proposal.evidence_id") for item in data["evidence_ids"]],
        "existing_rules": existing_rules,
        "proposed_rules": proposed_rules,
        "rationale": checked_text(data["rationale"], "proposal.rationale", maximum=4000),
        "status": data["status"],
        "resolved_at": _optional_text(data["resolved_at"], "proposal.resolved_at", 64),
        "commit": commit,
    }


class PreferenceStore:
    """All writes are short, atomic, and serialized through one local lock."""

    def __init__(self, data_root: str | Path):
        raw_root = Path(data_root).expanduser()
        if raw_root.is_symlink():
            raise PreferenceIntegrityError("preference data root cannot be a symlink")
        self.root = raw_root.resolve()
        self.local = self.root / "local"
        self.config_path = self.root / "config.json"
        self.repo = self._repo_path()
        self.groups_path = self.repo / "groups.json"
        self.activations_path = self.local / "activations.json"
        self.learning_path = self.local / "learning.json"
        self.lock_path = self.local / "data.lock"

    def _repo_path(self) -> Path:
        repo_name = "repo"
        if self.config_path.exists():
            config = read_json(self.config_path, "config")
            if not isinstance(config, dict):
                raise PreferenceIntegrityError("config must be an object")
            configured = config.get("repo_path", "repo")
            if not isinstance(configured, str) or not configured or "\x00" in configured:
                raise PreferenceIntegrityError("config repo_path is invalid")
            candidate = Path(configured)
            if candidate.is_absolute() or any(part in {"", ".", ".."} for part in candidate.parts):
                raise PreferenceIntegrityError("config repo_path must stay below the data root")
            repo_name = configured
        candidate = self.root.joinpath(repo_name)
        current = self.root
        for part in Path(repo_name).parts:
            current /= part
            if current.is_symlink():
                raise PreferenceIntegrityError("config repo_path cannot traverse a symlink")
        resolved = candidate.resolve()
        if self.root != resolved and self.root not in resolved.parents:
            raise PreferenceIntegrityError("config repo_path escapes the data root")
        return resolved

    @contextlib.contextmanager
    def locked(self) -> Iterator[None]:
        _safe_dir(self.root)
        _safe_dir(self.local)
        _safe_file(self.lock_path, missing=True)
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def initialize(self) -> bool:
        from .git_sync import ensure_repository, commit_groups, head

        created = False
        created_groups = False
        with self.locked():
            _safe_dir(self.repo)
            if not self.config_path.exists():
                atomic_write(self.config_path, {
                    "schema_version": 3,
                    "enabled": True,
                    "repo_path": "repo",
                })
                created = True
            if not self.groups_path.exists():
                atomic_write(self.groups_path, {
                    "schema_version": GROUPS_SCHEMA_VERSION,
                    "groups": [{
                        "id": new_id("grp-"),
                        "revision": 1,
                        "name": "global",
                        "description": "适用于所有 Pi 会话的通用个人偏好。",
                        "rules": [],
                    }],
                })
                created = True
                created_groups = True
            else:
                self.groups()
            if not self.activations_path.exists():
                atomic_write(self.activations_path, {"schema_version": 2, "directories": {}, "sessions": {}})
                created = True
            else:
                self.activations()
            if not self.learning_path.exists():
                atomic_write(self.learning_path, self.empty_learning())
                created = True
            else:
                self.learning()
            ensure_repository(self.repo)
            if created_groups or head(self.repo) is None:
                commit_groups(self.repo, "personal-preferences: initialize")
        return created

    @staticmethod
    def empty_learning() -> dict[str, Any]:
        return {"schema_version": LEARNING_SCHEMA_VERSION, "feedback": [], "evidence": [], "proposals": [], "reviewed_evidence": {}}

    def config(self) -> dict[str, Any]:
        value = read_json(self.config_path, "config")
        if not isinstance(value, dict):
            raise PreferenceIntegrityError("config must be an object")
        return value

    def enabled(self) -> bool:
        value = self.config().get("enabled", True)
        if not isinstance(value, bool):
            raise PreferenceIntegrityError("config enabled must be boolean")
        return value

    def groups(self) -> dict[str, Any]:
        return validate_groups_document(read_json(self.groups_path, "groups"))

    def write_groups(self, value: Any) -> None:
        atomic_write(self.groups_path, validate_groups_document(value))

    def activations(self) -> dict[str, Any]:
        return validate_activations(read_json(self.activations_path, "activations"))

    def write_activations(self, value: Any) -> None:
        atomic_write(self.activations_path, validate_activations(value))

    def learning(self) -> dict[str, Any]:
        value = read_json(self.learning_path, "learning")
        data = _strict_object(value, {"schema_version", "feedback", "evidence", "proposals", "reviewed_evidence"}, {"schema_version", "feedback", "evidence", "proposals", "reviewed_evidence"}, "learning")
        if data["schema_version"] != LEARNING_SCHEMA_VERSION:
            raise PreferenceIntegrityError("learning schema_version is unsupported")
        if not all(isinstance(data[key], list) for key in ("feedback", "evidence", "proposals")) or not isinstance(data["reviewed_evidence"], dict):
            raise PreferenceIntegrityError("learning collections are invalid")
        reviewed: dict[str, list[str]] = {}
        for raw_group_id, raw_evidence_ids in data["reviewed_evidence"].items():
            group_id = checked_id(raw_group_id, "reviewed group_id")
            if not isinstance(raw_evidence_ids, list):
                raise PreferenceIntegrityError("reviewed evidence IDs must be a list")
            reviewed[group_id] = list(dict.fromkeys(checked_id(item, "reviewed evidence_id") for item in raw_evidence_ids))
        return {
            "schema_version": LEARNING_SCHEMA_VERSION,
            "feedback": [validate_feedback_record(item) for item in data["feedback"]],
            "evidence": [validate_evidence_record(item) for item in data["evidence"]],
            "proposals": [validate_proposal_record(item) for item in data["proposals"]],
            "reviewed_evidence": reviewed,
        }

    def write_learning(self, value: Any) -> None:
        atomic_write(self.learning_path, value)

    def group_by_name(self, name: str, document: dict[str, Any] | None = None) -> dict[str, Any]:
        clean = checked_text(name, "group", maximum=128)
        groups = (document or self.groups())["groups"]
        group = next((item for item in groups if item["name"] == clean), None)
        if group is None:
            raise PreferenceValidationError(f"unknown preference group: {clean}")
        return group

    def group_by_id(self, group_id: str, document: dict[str, Any] | None = None) -> dict[str, Any]:
        clean = checked_id(group_id, "group_id")
        groups = (document or self.groups())["groups"]
        group = next((item for item in groups if item["id"] == clean), None)
        if group is None:
            raise PreferenceValidationError(f"unknown preference group id: {clean}")
        return group

    @staticmethod
    def group_digest(group: dict[str, Any]) -> str:
        return digest(group)

    @staticmethod
    def active_rule_texts(group: dict[str, Any]) -> list[str]:
        return [item["text"] for item in group["rules"] if item["enabled"]]

    @staticmethod
    def replace_group(document: dict[str, Any], replacement: dict[str, Any]) -> dict[str, Any]:
        return validate_groups_document({
            "schema_version": GROUPS_SCHEMA_VERSION,
            "groups": [replacement if item["id"] == replacement["id"] else item for item in document["groups"]],
        })

    @staticmethod
    def build_rule_replacement(group: dict[str, Any], proposed_rules: list[str]) -> dict[str, Any]:
        if proposed_rules == PreferenceStore.active_rule_texts(group):
            return group
        existing_active = {item["text"]: item for item in group["rules"] if item["enabled"]}
        retained_disabled = [item for item in group["rules"] if not item["enabled"]]
        active_rules: list[dict[str, Any]] = []
        for text in proposed_rules:
            current = existing_active.get(text)
            active_rules.append(current if current is not None else {"id": new_id("rule-"), "revision": 1, "text": text, "enabled": True})
        return validate_group({**group, "revision": group["revision"] + 1, "rules": [*active_rules, *retained_disabled]})

    def require_feedback(self, learning: dict[str, Any], feedback_id: str) -> dict[str, Any]:
        clean = checked_id(feedback_id, "feedback_id")
        feedback = next((item for item in learning["feedback"] if item.get("id") == clean), None)
        if feedback is None:
            raise PreferenceValidationError(f"unknown feedback: {clean}")
        return feedback

    def pending_proposal(self, learning: dict[str, Any], group_id: str) -> dict[str, Any] | None:
        return next((item for item in reversed(learning["proposals"]) if item.get("group_id") == group_id and item.get("status") == "pending"), None)
