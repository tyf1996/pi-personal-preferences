"""Strict contracts for the personal preference group model."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Mapping

from .errors import PreferenceContractError
from .sanitizing import DEFAULT_DENIED_FILE_NAMES, path_is_denied

GROUPS_SCHEMA_VERSION_V1 = 1
GROUPS_SCHEMA_VERSION_V2 = 2
ACTIVATIONS_SCHEMA_VERSION_V1 = 1
ACTIVATIONS_SCHEMA_VERSION_V2 = 2
EVENT_SCHEMA_VERSION_V1 = 1
CLASSIFICATION_SCHEMA_VERSION_V1 = 1
VERSION_SCHEMA_VERSION_V2 = 2


class Signal(str, Enum):
    REMEMBER = "remember"
    REJECTION = "rejection"
    USER_EDIT = "user_edit"
    ACCEPTANCE = "acceptance"


class EvolutionAction(str, Enum):
    ADD = "add"
    REPLACE = "replace"
    DELETE = "delete"
    NOOP = "noop"


SIGNALS = tuple(item.value for item in Signal)
EVOLUTION_ACTIONS = tuple(item.value for item in EvolutionAction)
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PATH_RE = re.compile(r"^[^/\\\x00][^\x00]*$")


def stable_json_dumps(value: Any) -> str:
    """Serialize JSON deterministically and without ASCII escaping."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def stable_hash(value: Any) -> str:
    payload = value if isinstance(value, bytes) else stable_json_dumps(value).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def hash_ref(value: Any) -> str:
    return f"sha256:{stable_hash(value)}"


def new_id(prefix: str = "") -> str:
    value = uuid.uuid4().hex
    return f"{prefix}{value}" if prefix else value


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or isinstance(value, list):
        raise PreferenceContractError(f"{label} must be an object")
    return dict(value)


def _strict(value: Any, required: set[str], allowed: set[str], label: str) -> dict[str, Any]:
    data = _object(value, label)
    missing = required - set(data)
    unknown = set(data) - allowed
    if missing:
        raise PreferenceContractError(f"{label} missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceContractError(f"{label} unknown keys: {sorted(map(str, unknown))}")
    return data


def _string(
    value: Any,
    label: str,
    *,
    non_empty: bool = True,
    max_length: int | None = None,
) -> str:
    if not isinstance(value, str) or (non_empty and not value.strip()):
        raise PreferenceContractError(f"{label} must be a non-empty string")
    if any(ord(char) < 32 for char in value):
        raise PreferenceContractError(f"{label} contains a control character")
    if max_length is not None and len(value) > max_length:
        raise PreferenceContractError(f"{label} exceeds {max_length} characters")
    return value


def _safe_id(value: Any, label: str) -> str:
    result = _string(value, label)
    if not _ID_RE.fullmatch(result):
        raise PreferenceContractError(f"{label} must be a path-safe identifier")
    return result


def _integer(value: Any, label: str, *, minimum: int | None = None) -> int:
    if type(value) is not int:
        raise PreferenceContractError(f"{label} must be an integer")
    if minimum is not None and value < minimum:
        raise PreferenceContractError(f"{label} must be >= {minimum}")
    return value


def _boolean(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise PreferenceContractError(f"{label} must be a boolean")
    return value


def _timestamp(value: Any, label: str) -> str:
    result = _string(value, label)
    try:
        datetime.fromisoformat(result.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PreferenceContractError(f"{label} must be an ISO-8601 timestamp") from exc
    return result


def safe_relative_path(value: Any, label: str = "path") -> str:
    result = _string(value, label)
    if "\x00" in result or result.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", result):
        raise PreferenceContractError(f"{label} must be a relative project path")
    parts = result.replace("\\", "/").split("/")
    if any(part in {"", ".", ".."} for part in parts) or not _PATH_RE.fullmatch(result):
        raise PreferenceContractError(f"{label} must be a normalized relative project path")
    return "/".join(parts)


def _paths(value: Any, label: str = "paths") -> list[str]:
    if not isinstance(value, list):
        raise PreferenceContractError(f"{label} must be a list")
    result = [safe_relative_path(item, f"{label}[{index}]") for index, item in enumerate(value)]
    if len(result) != len(set(result)):
        raise PreferenceContractError(f"{label} must not contain duplicates")
    if len(result) > 64 or any(len(path) > 256 for path in result):
        raise PreferenceContractError(f"{label} is too large")
    if any(path_is_denied(path, DEFAULT_DENIED_FILE_NAMES) for path in result):
        raise PreferenceContractError(f"{label} contains a denied path")
    return result


def _nullable_id(value: Any, label: str) -> str | None:
    if value is None:
        return None
    return _safe_id(value, label)


def _group_name(value: Any, label: str = "group") -> str:
    # Group names are data keys, not filesystem paths.  They only need the
    # common text safety and length constraints so names remain unambiguous in
    # prompts, CLI arguments, and activation documents.
    return _string(value, label, max_length=128).strip()


def _signal(value: Any, label: str) -> Signal:
    try:
        return Signal(_string(value, label))
    except ValueError as exc:
        raise PreferenceContractError(f"{label} has unsupported value: {value!r}") from exc


def _deduplicated_strings(value: Any, label: str) -> list[str]:
    if not isinstance(value, list):
        raise PreferenceContractError(f"{label} must be a list")
    result = [_string(item, f"{label}[{index}]", max_length=1000).strip()
              for index, item in enumerate(value)]
    if len(result) != len(set(result)):
        raise PreferenceContractError(f"{label} must not contain duplicate values")
    return result


@dataclass(frozen=True)
class PreferenceGroup:
    name: str
    description: str
    rules: list[str]

    @classmethod
    def from_dict(cls, value: Any) -> "PreferenceGroup":
        data = _strict(value, {"name", "description", "rules"}, {"name", "description", "rules"}, "preference group")
        rules = _deduplicated_strings(data["rules"], "group.rules")
        return cls(
            name=_group_name(data["name"], "group.name"),
            description=_string(data["description"], "group.description", max_length=2000).strip(),
            rules=rules,
        )

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "rules": list(self.rules)}


@dataclass(frozen=True)
class PreferenceRuleV2:
    id: str
    revision: int
    text: str
    enabled: bool

    @classmethod
    def from_dict(cls, value: Any) -> "PreferenceRuleV2":
        data = _strict(
            value,
            {"id", "revision", "text", "enabled"},
            {"id", "revision", "text", "enabled"},
            "preference rule v2",
        )
        return cls(
            _safe_id(data["id"], "rule.id"),
            _integer(data["revision"], "rule.revision", minimum=1),
            _string(data["text"], "rule.text", max_length=1000).strip(),
            _boolean(data["enabled"], "rule.enabled"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "revision": self.revision,
            "text": self.text,
            "enabled": self.enabled,
        }


@dataclass(frozen=True)
class PreferenceGroupV2:
    id: str
    revision: int
    name: str
    description: str
    rules: list[PreferenceRuleV2]

    @classmethod
    def from_dict(cls, value: Any) -> "PreferenceGroupV2":
        data = _strict(
            value,
            {"id", "revision", "name", "description", "rules"},
            {"id", "revision", "name", "description", "rules"},
            "preference group v2",
        )
        if not isinstance(data["rules"], list):
            raise PreferenceContractError("group.rules must be a list")
        rules = [PreferenceRuleV2.from_dict(item) for item in data["rules"]]
        if len({rule.id for rule in rules}) != len(rules):
            raise PreferenceContractError("preference group contains duplicate rule IDs")
        if len({rule.text for rule in rules}) != len(rules):
            raise PreferenceContractError("preference group contains duplicate rule text")
        return cls(
            _safe_id(data["id"], "group.id"),
            _integer(data["revision"], "group.revision", minimum=1),
            _group_name(data["name"], "group.name"),
            _string(data["description"], "group.description", max_length=2000).strip(),
            rules,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "revision": self.revision,
            "name": self.name,
            "description": self.description,
            "rules": [rule.to_dict() for rule in self.rules],
        }

    def legacy_view(self) -> PreferenceGroup:
        return PreferenceGroup(
            self.name,
            self.description,
            [rule.text for rule in self.rules if rule.enabled],
        )


@dataclass(frozen=True)
class PreferenceGroupsDocument:
    schema_version: int
    groups: list[PreferenceGroup]

    @classmethod
    def from_dict(cls, value: Any) -> "PreferenceGroupsDocument":
        data = _strict(value, {"schema_version", "groups"}, {"schema_version", "groups"}, "preference groups document")
        if _integer(data["schema_version"], "groups.schema_version") != GROUPS_SCHEMA_VERSION_V1:
            raise PreferenceContractError("groups schema_version must be 1")
        raw_groups = data["groups"]
        if not isinstance(raw_groups, list):
            raise PreferenceContractError("groups.groups must be a list")
        groups = [PreferenceGroup.from_dict(item) for item in raw_groups]
        if len({group.name for group in groups}) != len(groups):
            raise PreferenceContractError("groups document contains duplicate group names")
        return cls(GROUPS_SCHEMA_VERSION_V1, groups)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "groups": [group.to_dict() for group in self.groups],
        }


@dataclass(frozen=True)
class PreferenceGroupsDocumentV2:
    schema_version: int
    groups: list[PreferenceGroupV2]

    @classmethod
    def from_dict(cls, value: Any) -> "PreferenceGroupsDocumentV2":
        data = _strict(value, {"schema_version", "groups"}, {"schema_version", "groups"}, "preference groups document v2")
        if _integer(data["schema_version"], "groups.schema_version") != GROUPS_SCHEMA_VERSION_V2:
            raise PreferenceContractError("groups schema_version must be 2")
        if not isinstance(data["groups"], list):
            raise PreferenceContractError("groups.groups must be a list")
        groups = [PreferenceGroupV2.from_dict(item) for item in data["groups"]]
        if len({group.id for group in groups}) != len(groups):
            raise PreferenceContractError("groups document contains duplicate group IDs")
        if len({group.name for group in groups}) != len(groups):
            raise PreferenceContractError("groups document contains duplicate group names")
        rule_ids = [rule.id for group in groups for rule in group.rules]
        if len(rule_ids) != len(set(rule_ids)):
            raise PreferenceContractError("groups document contains duplicate rule IDs")
        return cls(GROUPS_SCHEMA_VERSION_V2, groups)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "groups": [group.to_dict() for group in self.groups],
        }


def groups_document(groups: list[PreferenceGroup]) -> dict[str, Any]:
    return PreferenceGroupsDocument(GROUPS_SCHEMA_VERSION_V1, list(groups)).to_dict()


def groups_document_v2(groups: list[PreferenceGroupV2]) -> dict[str, Any]:
    return PreferenceGroupsDocumentV2(GROUPS_SCHEMA_VERSION_V2, list(groups)).to_dict()


def parse_groups_document_versioned(value: Any) -> PreferenceGroupsDocument | PreferenceGroupsDocumentV2:
    data = _object(value, "preference groups document")
    version = data.get("schema_version")
    if version == GROUPS_SCHEMA_VERSION_V1:
        return PreferenceGroupsDocument.from_dict(data)
    if version == GROUPS_SCHEMA_VERSION_V2:
        return PreferenceGroupsDocumentV2.from_dict(data)
    raise PreferenceContractError(f"groups schema_version is unsupported: {version!r}")


def parse_groups_document(value: Any) -> list[PreferenceGroup]:
    document = parse_groups_document_versioned(value)
    if isinstance(document, PreferenceGroupsDocumentV2):
        return [group.legacy_view() for group in document.groups]
    return document.groups


@dataclass(frozen=True)
class GroupActivationDocument:
    schema_version: int
    directories: dict[str, list[str]]
    sessions: dict[str, list[str]]

    @classmethod
    def from_dict(cls, value: Any) -> "GroupActivationDocument":
        data = _strict(
            value,
            {"schema_version", "directories", "sessions"},
            {"schema_version", "directories", "sessions"},
            "group activation document",
        )
        if _integer(data["schema_version"], "activations.schema_version") != ACTIVATIONS_SCHEMA_VERSION_V1:
            raise PreferenceContractError("activations schema_version must be 1")
        return cls(
            ACTIVATIONS_SCHEMA_VERSION_V1,
            _activation_map(data["directories"], "activations.directories"),
            _activation_map(data["sessions"], "activations.sessions"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "directories": {key: list(value) for key, value in self.directories.items()},
            "sessions": {key: list(value) for key, value in self.sessions.items()},
        }


def _activation_map(value: Any, label: str) -> dict[str, list[str]]:
    data = _object(value, label)
    result: dict[str, list[str]] = {}
    for key, groups in data.items():
        if not isinstance(key, str) or not key.strip():
            raise PreferenceContractError(f"{label} keys must be non-empty strings")
        if not isinstance(groups, list):
            raise PreferenceContractError(f"{label}[{key!r}] must be a list")
        normalized: list[str] = []
        for index, group in enumerate(groups):
            name = _group_name(group, f"{label}[{key!r}][{index}]")
            if name not in normalized:
                normalized.append(name)
        result[key] = normalized
    return result


@dataclass(frozen=True)
class GroupActivationDocumentV2:
    schema_version: int
    directories: dict[str, list[str]]
    sessions: dict[str, list[str]]

    @classmethod
    def from_dict(cls, value: Any) -> "GroupActivationDocumentV2":
        data = _strict(
            value,
            {"schema_version", "directories", "sessions"},
            {"schema_version", "directories", "sessions"},
            "group activation document v2",
        )
        if _integer(data["schema_version"], "activations.schema_version") != ACTIVATIONS_SCHEMA_VERSION_V2:
            raise PreferenceContractError("activations schema_version must be 2")
        return cls(
            ACTIVATIONS_SCHEMA_VERSION_V2,
            _activation_id_map(data["directories"], "activations.directories"),
            _activation_id_map(data["sessions"], "activations.sessions"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "directories": {key: list(value) for key, value in self.directories.items()},
            "sessions": {key: list(value) for key, value in self.sessions.items()},
        }


def _activation_id_map(value: Any, label: str) -> dict[str, list[str]]:
    data = _object(value, label)
    result: dict[str, list[str]] = {}
    for key, groups in data.items():
        if not isinstance(key, str) or not key.strip():
            raise PreferenceContractError(f"{label} keys must be non-empty strings")
        if not isinstance(groups, list):
            raise PreferenceContractError(f"{label}[{key!r}] must be a list")
        normalized: list[str] = []
        for index, group in enumerate(groups):
            group_id = _safe_id(group, f"{label}[{key!r}][{index}]")
            if group_id not in normalized:
                normalized.append(group_id)
        result[key] = normalized
    return result


def activations_document(
    directories: dict[str, list[str]],
    sessions: dict[str, list[str]],
) -> dict[str, Any]:
    return GroupActivationDocument(ACTIVATIONS_SCHEMA_VERSION_V1, directories, sessions).to_dict()


def activations_document_v2(
    directories: dict[str, list[str]],
    sessions: dict[str, list[str]],
) -> dict[str, Any]:
    return GroupActivationDocumentV2(ACTIVATIONS_SCHEMA_VERSION_V2, directories, sessions).to_dict()


def parse_activations_document_versioned(value: Any) -> GroupActivationDocument | GroupActivationDocumentV2:
    data = _object(value, "group activation document")
    version = data.get("schema_version")
    if version == ACTIVATIONS_SCHEMA_VERSION_V1:
        return GroupActivationDocument.from_dict(data)
    if version == ACTIVATIONS_SCHEMA_VERSION_V2:
        return GroupActivationDocumentV2.from_dict(data)
    raise PreferenceContractError(f"activations schema_version is unsupported: {version!r}")


def parse_activations_document(value: Any) -> GroupActivationDocument:
    document = parse_activations_document_versioned(value)
    if isinstance(document, GroupActivationDocumentV2):
        raise PreferenceContractError("v2 activations require group ID resolution")
    return document


@dataclass(frozen=True)
class GroupClassificationRequest:
    schema_version: int
    preference_text: str
    task_summary: str
    touched_paths: list[str]
    groups: list[dict[str, str]]

    @classmethod
    def from_dict(cls, value: Any) -> "GroupClassificationRequest":
        data = _strict(
            value,
            {"schema_version", "preference_text", "task_summary", "touched_paths", "groups"},
            {"schema_version", "preference_text", "task_summary", "touched_paths", "groups"},
            "group classification request",
        )
        if _integer(data["schema_version"], "classification.schema_version") != CLASSIFICATION_SCHEMA_VERSION_V1:
            raise PreferenceContractError("group classification schema_version must be 1")
        raw_groups = data["groups"]
        if not isinstance(raw_groups, list) or not raw_groups:
            raise PreferenceContractError("classification.groups must be a non-empty list")
        groups: list[dict[str, str]] = []
        for index, raw_group in enumerate(raw_groups):
            item = _strict(
                raw_group,
                {"name", "description"},
                {"name", "description"},
                f"classification.groups[{index}]",
            )
            group = {
                "name": _group_name(item["name"], f"classification.groups[{index}].name"),
                "description": _string(
                    item["description"],
                    f"classification.groups[{index}].description",
                    max_length=2000,
                ).strip(),
            }
            groups.append(group)
        if len({item["name"] for item in groups}) != len(groups):
            raise PreferenceContractError("classification.groups must contain unique names")
        touched_paths = _paths(data["touched_paths"], "classification.touched_paths")
        return cls(
            CLASSIFICATION_SCHEMA_VERSION_V1,
            _string(data["preference_text"], "classification.preference_text", max_length=2000).strip(),
            _string(data["task_summary"], "classification.task_summary", non_empty=False, max_length=1000).strip(),
            touched_paths,
            groups,
        )

    def validate_for(self, configured_group_names: list[str] | tuple[str, ...] | set[str]) -> "GroupClassificationRequest":
        configured = set(configured_group_names)
        requested = {item["name"] for item in self.groups}
        if not configured or requested != configured:
            raise PreferenceContractError("classification groups must exactly match the configured groups")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "preference_text": self.preference_text,
            "task_summary": self.task_summary,
            "touched_paths": list(self.touched_paths),
            "groups": [dict(item) for item in self.groups],
        }


@dataclass(frozen=True)
class GroupClassificationResult:
    group: str

    @classmethod
    def from_dict(
        cls,
        value: Any,
        available_groups: list[str] | tuple[str, ...] | set[str] | None = None,
    ) -> "GroupClassificationResult":
        data = _strict(value, {"group"}, {"group"}, "group classification result")
        result = cls(_group_name(data["group"], "classification.group"))
        if available_groups is not None:
            result.validate_for(available_groups)
        return result

    def validate_for(self, available_groups: list[str] | tuple[str, ...] | set[str]) -> "GroupClassificationResult":
        if self.group not in set(available_groups):
            raise PreferenceContractError(f"classification group is not available: {self.group}")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {"group": self.group}


@dataclass(frozen=True)
class PreferenceEvent:
    schema_version: int
    id: str
    created_at: str
    group: str
    signal: Signal
    summary: str
    task_id: str | None = None
    paths: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: Any) -> "PreferenceEvent":
        allowed = {"schema_version", "id", "created_at", "group", "signal", "summary", "task_id", "paths"}
        data = _strict(
            value,
            {"schema_version", "id", "created_at", "group", "signal", "summary"},
            allowed,
            "preference event",
        )
        if _integer(data["schema_version"], "event.schema_version") != EVENT_SCHEMA_VERSION_V1:
            raise PreferenceContractError("preference event schema_version must be 1")
        return cls(
            EVENT_SCHEMA_VERSION_V1,
            _safe_id(data["id"], "event.id"),
            _timestamp(data["created_at"], "event.created_at"),
            _group_name(data["group"], "event.group"),
            _signal(data["signal"], "event.signal"),
            _string(data["summary"], "event.summary", max_length=2000).strip(),
            _nullable_id(data.get("task_id"), "event.task_id"),
            _paths(data.get("paths", []), "event.paths"),
        )

    def validate_for(self, group_names: list[str] | tuple[str, ...] | set[str]) -> "PreferenceEvent":
        if self.group not in set(group_names):
            raise PreferenceContractError(f"event group does not exist: {self.group}")
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "id": self.id,
            "created_at": self.created_at,
            "group": self.group,
            "signal": self.signal.value,
            "summary": self.summary,
            "task_id": self.task_id,
            "paths": list(self.paths),
        }


@dataclass(frozen=True)
class EvolutionChange:
    action: EvolutionAction
    group: str | None = None
    rule: str | None = None
    previous_rule: str | None = None
    evidence_ids: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, value: Any) -> "EvolutionChange":
        data = _object(value, "evolution change")
        if "action" not in data:
            raise PreferenceContractError("evolution change missing keys: ['action']")
        try:
            action = EvolutionAction(_string(data["action"], "change.action"))
        except ValueError as exc:
            raise PreferenceContractError(f"change.action has unsupported value: {data['action']!r}") from exc
        if action is EvolutionAction.NOOP:
            if set(data) != {"action"}:
                raise PreferenceContractError("noop change only accepts action")
            return cls(action)

        required = {"action", "group", "rule", "evidence_ids"}
        if action is EvolutionAction.REPLACE:
            required.add("previous_rule")
        allowed = set(required)
        if set(data) != allowed:
            missing = required - set(data)
            unknown = set(data) - allowed
            if missing:
                raise PreferenceContractError(f"{action.value} change missing keys: {sorted(missing)}")
            raise PreferenceContractError(f"{action.value} change unknown keys: {sorted(unknown)}")
        evidence_ids = data["evidence_ids"]
        if not isinstance(evidence_ids, list) or any(not isinstance(item, str) for item in evidence_ids):
            raise PreferenceContractError("change.evidence_ids must be a list of strings")
        if not evidence_ids:
            raise PreferenceContractError("non-noop changes must cite evidence_ids")
        evidence_ids = [_safe_id(item, "change.evidence_ids item") for item in evidence_ids]
        if len(evidence_ids) != len(set(evidence_ids)):
            raise PreferenceContractError("change.evidence_ids must not contain duplicates")
        previous_rule = None
        if action is EvolutionAction.REPLACE:
            previous_rule = _string(data["previous_rule"], "change.previous_rule", max_length=1000).strip()
        return cls(
            action,
            _group_name(data["group"], "change.group"),
            _string(data["rule"], "change.rule", max_length=1000).strip(),
            previous_rule,
            list(evidence_ids),
        )

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {"action": self.action.value}
        if self.group is not None:
            result["group"] = self.group
        if self.rule is not None:
            result["rule"] = self.rule
        if self.previous_rule is not None:
            result["previous_rule"] = self.previous_rule
        if self.evidence_ids:
            result["evidence_ids"] = list(self.evidence_ids)
        return result


@dataclass(frozen=True)
class EvolutionResponse:
    changes: list[EvolutionChange]

    @classmethod
    def from_dict(cls, value: Any) -> "EvolutionResponse":
        data = _strict(value, {"changes"}, {"changes"}, "evolution response")
        changes = data["changes"]
        if not isinstance(changes, list):
            raise PreferenceContractError("evolution response changes must be a list")
        if len(changes) > 3:
            raise PreferenceContractError("an evolution response may contain at most three changes")
        parsed = [EvolutionChange.from_dict(item) for item in changes]
        if not parsed:
            raise PreferenceContractError("evolution response must contain at least one change")
        return cls(parsed)

    def to_dict(self) -> dict[str, Any]:
        return {"changes": [change.to_dict() for change in self.changes]}
