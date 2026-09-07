"""Local evidence and personal preference group storage."""

from __future__ import annotations

import json
import os
import re
import secrets
import tempfile
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from .config import PreferenceConfig, default_config
from .contracts import (
    ACTIVATIONS_SCHEMA_VERSION_V1,
    ACTIVATIONS_SCHEMA_VERSION_V2,
    GROUPS_SCHEMA_VERSION_V1,
    GROUPS_SCHEMA_VERSION_V2,
    VERSION_SCHEMA_VERSION_V2,
    GroupActivationDocument,
    GroupActivationDocumentV2,
    PreferenceEvent,
    PreferenceGroup,
    PreferenceGroupV2,
    PreferenceGroupsDocument,
    PreferenceGroupsDocumentV2,
    PreferenceRuleV2,
    Signal,
    groups_document,
    groups_document_v2,
    new_id,
    parse_activations_document_versioned,
    parse_groups_document_versioned,
    stable_json_dumps,
    utc_now,
)
from .errors import PreferenceContractError, PreferenceIntegrityError, PreferenceStorageError
from .sanitizing import DEFAULT_DENIED_FILE_NAMES, path_is_denied, sanitize_text, safe_relative_project_path

DEVICE_KEYS = {"schema_version", "device_id"}
VERSION_KEYS_V2 = {
    "schema_version", "generator_version", "generated_at", "repo_id", "migration_id",
    "evidence_cursors", "model", "legacy_evidence",
}
ACTIVATIONS_DEFAULT = {"schema_version": ACTIVATIONS_SCHEMA_VERSION_V1, "directories": {}, "sessions": {}}
GENERATOR_VERSION_V2 = "wikiskill-personal-preferences/2"
_MAX_RAW_DIFF_BYTES = 512 * 1024


def _regular_file(path: Path, *, allow_missing: bool = True) -> None:
    if path.is_symlink():
        raise PreferenceIntegrityError(f"symlink is not allowed: {path}")
    if not path.exists():
        if allow_missing:
            return
        raise PreferenceStorageError(f"file does not exist: {path}")
    if not path.is_file():
        raise PreferenceStorageError(f"expected a regular file: {path}")


def _regular_directory(path: Path) -> None:
    if path.is_symlink():
        raise PreferenceIntegrityError(f"symlink is not allowed: {path}")
    if path.exists() and not path.is_dir():
        raise PreferenceStorageError(f"expected a directory: {path}")
    path.mkdir(parents=True, exist_ok=True)


def _existing_directory(path: Path) -> None:
    if path.is_symlink():
        raise PreferenceIntegrityError(f"symlink is not allowed: {path}")
    if not path.is_dir():
        raise PreferenceStorageError(f"expected an existing directory: {path}")


def _write_locked(method):
    def locked(self, *args, **kwargs):
        from .transactions import active_transaction_for, data_root_lock, recover_transactions

        with data_root_lock(self.root):
            if active_transaction_for(self.root / "config.json") is None:
                recover_transactions(self.root)
            return method(self, *args, **kwargs)

    locked.__name__ = method.__name__
    locked.__doc__ = method.__doc__
    return locked


def atomic_write_bytes(path: Path, content: bytes) -> None:
    """Write a file with fsync and an atomic replace in its parent directory."""

    from .transactions import active_transaction_for, secure_atomic_write

    transaction = active_transaction_for(path)
    if transaction is not None:
        transaction.record_after(path, content)
        secure_atomic_write(transaction.data_root, path, content)
        return
    _regular_directory(path.parent)
    if path.is_symlink():
        raise PreferenceIntegrityError(f"cannot replace symlink: {path}")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
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
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass
        raise PreferenceStorageError(f"cannot atomically write {path}: {exc}") from exc


def atomic_write_text(path: Path, content: str) -> None:
    atomic_write_bytes(path, content.encode("utf-8"))


def write_once(path: Path, content: bytes) -> None:
    """Create a file once; identical retries are idempotent."""

    if path.exists() or path.is_symlink():
        _regular_file(path, allow_missing=False)
        if path.read_bytes() == content:
            return
        raise PreferenceIntegrityError(f"write-once conflict: {path}")
    atomic_write_bytes(path, content)


def _read_json(path: Path, label: str) -> Any:
    _regular_file(path, allow_missing=False)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreferenceStorageError(f"cannot read {label}: {path}: {exc}") from exc


def _read_jsonl(path: Path, label: str) -> list[dict[str, Any]]:
    if path.is_symlink():
        raise PreferenceIntegrityError(f"symlink is not allowed: {path}")
    if not path.exists():
        return []
    _regular_file(path, allow_missing=False)
    rows: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError) as exc:
        raise PreferenceStorageError(f"cannot read {label}: {path}: {exc}") from exc
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise PreferenceIntegrityError(f"invalid JSONL at {path}:{line_number}: {exc}") from exc
        if not isinstance(value, dict):
            raise PreferenceIntegrityError(f"JSONL row at {path}:{line_number} must be an object")
        rows.append(value)
    return rows


def _append_jsonl(path: Path, value: dict[str, Any]) -> None:
    _regular_directory(path.parent)
    if path.is_symlink():
        raise PreferenceIntegrityError(f"cannot append to symlink: {path}")
    existing = path.read_bytes() if path.exists() else b""
    line = (stable_json_dumps(value) + "\n").encode("utf-8")
    atomic_write_bytes(path, existing + line)


def atomic_delete(path: Path) -> None:
    from .transactions import active_transaction_for, secure_atomic_delete

    transaction = active_transaction_for(path)
    if transaction is not None:
        transaction.record_after(path, None)
        secure_atomic_delete(transaction.data_root, path)
        return
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise PreferenceIntegrityError(f"cannot delete unsafe path: {path}")
    if path.exists():
        path.unlink()
        try:
            directory_fd = os.open(path.parent, os.O_DIRECTORY)
        except (AttributeError, OSError):
            return
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


def _unique_event_key(event: PreferenceEvent) -> tuple[str, str | None, str, str]:
    return event.group, event.task_id, event.signal.value, event.summary


def _group_sort_key(group: PreferenceGroup) -> tuple[int, str]:
    return (0 if group.name == "global" else 1, group.name)


class PreferenceStore:
    """Own persistent preference groups, activations, and evidence."""

    def __init__(self, data_root: str | Path):
        self.root = Path(data_root).resolve()
        self.config = PreferenceConfig.load(self.root)
        self.repo = self.config.repo_root
        self.local = self.config.local_root
        self._validate_layout()

    @classmethod
    def init(cls, data_root: str | Path) -> "PreferenceStore":
        from .transactions import data_root_lock, recover_transactions

        root = Path(data_root).resolve()
        with data_root_lock(root):
            recover_transactions(root)
            _regular_directory(root)
            config_path = root / "config.json"
            created_config = False
            if config_path.exists():
                config = PreferenceConfig.load(root)
            else:
                config = default_config(root)
                atomic_write_text(config_path, stable_json_dumps(config.to_dict()) + "\n")
                created_config = True
            try:
                _regular_directory(config.local_root)
                _regular_directory(config.repo_root)
                _regular_directory(config.repo_root / "evidence")
                store = cls(root)
                store._initialize_files(config)
                return store
            except Exception:
                if created_config and config_path.is_file() and not config_path.is_symlink():
                    atomic_delete(config_path)
                raise

    def _validate_layout(self) -> None:
        _existing_directory(self.root)
        _existing_directory(self.local)
        _existing_directory(self.repo)
        _existing_directory(self.repo / "evidence")

    def _initialize_files(self, config: PreferenceConfig) -> None:
        from .git_sync import (
            begin_generated_transaction,
            complete_generated_transaction,
            restore_generated_transaction,
        )

        transaction = begin_generated_transaction(
            self.repo,
            extra_paths=(self.device_path, self.local_root),
            data_root=self.root,
        )
        try:
            self._initialize_files_unchecked(config)
            complete_generated_transaction(transaction)
        except Exception:
            restore_generated_transaction(transaction)
            raise

    def _initialize_files_unchecked(self, _config: PreferenceConfig) -> None:
        device = self.device_path
        if device.exists():
            value = _read_json(device, "device")
            if (
                not isinstance(value, dict)
                or set(value) != DEVICE_KEYS
                or type(value.get("schema_version")) is not int
                or value.get("schema_version") != 1
                or not isinstance(value.get("device_id"), str)
                or not value.get("device_id")
                or not value["device_id"].isalnum()
            ):
                raise PreferenceIntegrityError("device.json is invalid")
        else:
            atomic_write_text(
                device,
                stable_json_dumps({"schema_version": 1, "device_id": secrets.token_hex(16)}) + "\n",
            )

        for directory in (self.local_root, self.raw_diff_root):
            _regular_directory(directory)
        for path in (self.inbox_path, self.metrics_path):
            if path.exists():
                _regular_file(path, allow_missing=False)
            else:
                atomic_write_text(path, "")

        if self.groups_path.exists():
            self.read_groups_v2()
        else:
            self.write_groups_v2([PreferenceGroupV2(
                id=new_id("grp-"), revision=1, name="global",
                description="适用于所有 Pi 会话的通用个人偏好。", rules=(),
            )])

        if self.activations_path.exists():
            self.read_activations()
        else:
            initial_activations = {"schema_version": ACTIVATIONS_SCHEMA_VERSION_V2, "directories": {}, "sessions": {}}
            atomic_write_text(self.activations_path, stable_json_dumps(initial_activations) + "\n")

        if self.last_run_path.exists():
            _regular_file(self.last_run_path, allow_missing=False)
        else:
            atomic_write_text(self.last_run_path, "{}\n")
        if not self.version_path.exists():
            atomic_write_text(self.version_path, stable_json_dumps(self.default_version()) + "\n")
        else:
            self.read_version()

        from .git_sync import ensure_repository, initialize_commit

        ensure_repository(self.repo)
        initialize_commit(self.repo)

    @property
    def device_path(self) -> Path:
        return self.root / "device.json"

    @property
    def local_root(self) -> Path:
        return self.local

    @property
    def groups_path(self) -> Path:
        return self.repo / "groups.json"

    @property
    def activations_path(self) -> Path:
        return self.local / "activations.json"

    @property
    def inbox_path(self) -> Path:
        return self.local / "inbox.jsonl"

    @property
    def raw_diff_root(self) -> Path:
        return self.local / "raw-diffs"

    @property
    def metrics_path(self) -> Path:
        return self.local / "metrics.jsonl"

    @property
    def last_run_path(self) -> Path:
        return self.local / "last-run.json"

    @property
    def version_path(self) -> Path:
        return self.repo / "version.json"

    @property
    def evidence_root(self) -> Path:
        return self.repo / "evidence"

    def device_id(self) -> str:
        value = _read_json(self.device_path, "device")
        if (
            not isinstance(value, dict)
            or set(value) != DEVICE_KEYS
            or type(value.get("schema_version")) is not int
            or value.get("schema_version") != 1
        ):
            raise PreferenceIntegrityError("device.json is invalid")
        device_id = value.get("device_id")
        if not isinstance(device_id, str) or not device_id or not all(char.isalnum() for char in device_id):
            raise PreferenceIntegrityError("device_id is invalid")
        return device_id

    def default_version(self) -> dict[str, Any]:
        return {"schema_version": VERSION_SCHEMA_VERSION_V2, "generator_version": GENERATOR_VERSION_V2,
                "generated_at": utc_now(), "repo_id": new_id("repo-"), "migration_id": "direct-v2",
                "evidence_cursors": {}, "model": None, "legacy_evidence": []}

    def read_version(self) -> dict[str, Any]:
        value = _read_json(self.version_path, "version")
        if not isinstance(value, dict):
            raise PreferenceIntegrityError("version.json must be an object")
        version = value.get("schema_version")
        expected_keys = VERSION_KEYS_V2
        expected_generator = GENERATOR_VERSION_V2
        if version != VERSION_SCHEMA_VERSION_V2:
            raise PreferenceIntegrityError(f"version.json schema_version is unsupported: {version!r}")
        if set(value) != expected_keys or value.get("generator_version") != expected_generator:
            raise PreferenceIntegrityError("version.json has an invalid shape or generator")
        if value.get("model") is not None and not isinstance(value.get("model"), str):
            raise PreferenceIntegrityError("version model must be a string or null")
        cursors = value.get("evidence_cursors")
        if not isinstance(cursors, dict) or any(
            not isinstance(key, str) or type(item) is not int or item < 0
            for key, item in cursors.items()
        ):
            raise PreferenceIntegrityError("version evidence cursors are invalid")
        if version == VERSION_SCHEMA_VERSION_V2:
            generated_at = value.get("generated_at")
            try:
                parsed_time = datetime.fromisoformat(str(generated_at).replace("Z", "+00:00"))
            except ValueError as exc:
                raise PreferenceIntegrityError("version generated_at is invalid") from exc
            if parsed_time.tzinfo is None or parsed_time.utcoffset() is None:
                raise PreferenceIntegrityError("version generated_at must include a timezone")
            for key in ("repo_id", "migration_id"):
                item = value.get(key)
                if not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", item):
                    raise PreferenceIntegrityError(f"version {key} is invalid")
            if any(
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl", key)
                for key in cursors
            ):
                raise PreferenceIntegrityError("version v2 evidence cursor path is invalid")
            legacy = value.get("legacy_evidence")
            if not isinstance(legacy, list):
                raise PreferenceIntegrityError("version legacy_evidence must be a list")
            seen_paths: set[str] = set()
            for item in legacy:
                if not isinstance(item, dict) or set(item) != {"path", "line_count", "digest"}:
                    raise PreferenceIntegrityError("version legacy_evidence entry is invalid")
                path = item["path"]
                if (
                    not isinstance(path, str)
                    or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jsonl", path)
                    or path in seen_paths
                ):
                    raise PreferenceIntegrityError("version legacy evidence path is invalid")
                seen_paths.add(path)
                if type(item["line_count"]) is not int or item["line_count"] < 0:
                    raise PreferenceIntegrityError("version legacy evidence line_count is invalid")
                digest = item["digest"]
                if not isinstance(digest, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                    raise PreferenceIntegrityError("version legacy evidence digest is invalid")
        return value

    @_write_locked
    def write_version(self, *, cursors: dict[str, int], model: str | None) -> None:
        previous = self.read_version()
        value = {
            **previous,
            "generated_at": utc_now(),
            "evidence_cursors": {key: int(cursors[key]) for key in sorted(cursors)},
            "model": model,
        }
        atomic_write_text(self.version_path, stable_json_dumps(value) + "\n")

    def read_groups_document(self) -> PreferenceGroupsDocument | PreferenceGroupsDocumentV2:
        document = parse_groups_document_versioned(_read_json(self.groups_path, "preference groups"))
        if not isinstance(document, PreferenceGroupsDocumentV2):
            raise PreferenceIntegrityError("preference groups must use schema_version=2")
        groups = document.groups
        for group in groups:
            if sanitize_text(group.description).changed:
                raise PreferenceIntegrityError("stored preference group is not sanitized")
            rules = group.rules if isinstance(group, PreferenceGroup) else [rule.text for rule in group.rules]
            if any(sanitize_text(rule).changed for rule in rules):
                raise PreferenceIntegrityError("stored preference group is not sanitized")
        return document

    def groups_schema_version(self) -> int:
        return self.read_groups_document().schema_version

    def read_groups(self) -> list[PreferenceGroup]:
        document = self.read_groups_document()
        if isinstance(document, PreferenceGroupsDocumentV2):
            return [group.legacy_view() for group in document.groups]
        return document.groups

    def read_groups_v2(self) -> list[PreferenceGroupV2]:
        document = self.read_groups_document()
        if not isinstance(document, PreferenceGroupsDocumentV2):
            raise PreferenceContractError("groups document is not v2")
        return document.groups

    @_write_locked
    def write_groups_v2(self, groups: Iterable[PreferenceGroupV2]) -> None:
        normalized = [PreferenceGroupV2.from_dict(group.to_dict()) for group in groups]
        normalized.sort(key=lambda group: (group.name != "global", group.name))
        atomic_write_text(self.groups_path, stable_json_dumps(groups_document_v2(normalized)) + "\n")

    @_write_locked
    def write_groups(self, groups: Iterable[PreferenceGroup] | PreferenceGroupsDocument) -> None:
        raise PreferenceContractError("write_groups is unavailable; latest groups require stable IDs")
        values = groups.groups if isinstance(groups, PreferenceGroupsDocument) else groups
        normalized: list[PreferenceGroup] = []
        for group in values:
            parsed = group if isinstance(group, PreferenceGroup) else PreferenceGroup.from_dict(group)
            normalized.append(PreferenceGroup.from_dict({
                "name": parsed.name,
                "description": sanitize_text(parsed.description).text,
                "rules": [sanitize_text(rule).text for rule in parsed.rules],
            }))
        if len({group.name for group in normalized}) != len(normalized):
            raise PreferenceContractError("groups document contains duplicate group names")
        normalized.sort(key=_group_sort_key)
        atomic_write_text(self.groups_path, stable_json_dumps(groups_document(normalized)) + "\n")

    def group_names(self) -> list[str]:
        return [group.name for group in self.read_groups()]

    def group_count(self) -> int:
        return len(self.read_groups())

    def rule_count(self) -> int:
        return sum(len(group.rules) for group in self.read_groups())

    def _require_group(self, name: str) -> PreferenceGroup:
        if not isinstance(name, str) or not name.strip():
            raise PreferenceContractError("group must be a non-empty string")
        group = next((item for item in self.read_groups() if item.name == name), None)
        if group is None:
            raise PreferenceContractError(f"unknown preference group: {name}")
        return group

    def _require_group_v2(self, name: str) -> PreferenceGroupV2:
        group = next((item for item in self.read_groups_v2() if item.name == name), None)
        if group is None:
            raise PreferenceContractError(f"unknown preference group: {name}")
        return group

    @_write_locked
    def create_group(self, name: str, description: str) -> PreferenceGroup:
        raw_group = PreferenceGroup.from_dict({"name": name, "description": description, "rules": []})
        group = PreferenceGroup.from_dict({
            "name": raw_group.name,
            "description": sanitize_text(raw_group.description).text,
            "rules": [],
        })
        if self.groups_schema_version() == GROUPS_SCHEMA_VERSION_V2:
            groups = self.read_groups_v2()
            if any(item.name == group.name for item in groups):
                raise PreferenceContractError(f"preference group already exists: {group.name}")
            self.write_groups_v2([*groups, PreferenceGroupV2(new_id("grp-"), 1, group.name, group.description, [])])
            return group
        groups = self.read_groups()
        if any(item.name == group.name for item in groups):
            raise PreferenceContractError(f"preference group already exists: {group.name}")
        self.write_groups([*groups, group])
        return group

    @_write_locked
    def update_group_description(self, name: str, description: str) -> PreferenceGroup:
        original = self._require_group(name)
        raw_group = PreferenceGroup.from_dict({
            "name": name,
            "description": description,
            "rules": list(original.rules),
        })
        validated = PreferenceGroup.from_dict({
            "name": raw_group.name,
            "description": sanitize_text(raw_group.description).text,
            "rules": list(original.rules),
        })
        if self.groups_schema_version() == GROUPS_SCHEMA_VERSION_V2:
            groups = self.read_groups_v2()
            current = self._require_group_v2(name)
            replacement = PreferenceGroupV2(
                current.id, current.revision + 1, current.name, validated.description, list(current.rules),
            )
            self.write_groups_v2([replacement if group.name == name else group for group in groups])
            return replacement.legacy_view()
        self.write_groups([validated if group.name == name else group for group in self.read_groups()])
        return validated

    @_write_locked
    def delete_group(self, name: str) -> PreferenceGroup:
        group = self._require_group(name)
        if self.groups_schema_version() == GROUPS_SCHEMA_VERSION_V2:
            self.write_groups_v2([item for item in self.read_groups_v2() if item.name != name])
        else:
            self.write_groups([item for item in self.read_groups() if item.name != name])
        self.remove_inbox_group(name)
        return group

    def _validated_rule(self, group: str, description: str, rule: str) -> str:
        raw_group = PreferenceGroup.from_dict({"name": group, "description": description, "rules": [rule]})
        return sanitize_text(raw_group.rules[0]).text

    @_write_locked
    def add_group_rule(self, group: str, rule: str) -> PreferenceGroup:
        current = self._require_group(group)
        new_value = self._validated_rule(group, current.description, rule)
        if new_value in current.rules:
            raise PreferenceContractError(f"preference rule already exists in group: {group}")
        if self.groups_schema_version() == GROUPS_SCHEMA_VERSION_V2:
            groups = self.read_groups_v2()
            current_v2 = self._require_group_v2(group)
            replacement = PreferenceGroupV2(
                current_v2.id,
                current_v2.revision + 1,
                current_v2.name,
                current_v2.description,
                [*current_v2.rules, PreferenceRuleV2(new_id("rule-"), 1, new_value, True)],
            )
            self.write_groups_v2([replacement if item.name == group else item for item in groups])
            return replacement.legacy_view()
        replacement = PreferenceGroup(current.name, current.description, [*current.rules, new_value])
        self.write_groups([replacement if item.name == group else item for item in self.read_groups()])
        return replacement

    @_write_locked
    def update_group_rule(self, group: str, old_rule: str, new_rule: str) -> PreferenceGroup:
        current = self._require_group(group)
        if old_rule not in current.rules:
            raise PreferenceContractError(f"unknown preference rule in group: {group}")
        new_value = self._validated_rule(group, current.description, new_rule)
        if new_value != old_rule and new_value in current.rules:
            raise PreferenceContractError(f"preference rule already exists in group: {group}")
        if self.groups_schema_version() == GROUPS_SCHEMA_VERSION_V2:
            groups = self.read_groups_v2()
            current_v2 = self._require_group_v2(group)
            rules = [
                PreferenceRuleV2(item.id, item.revision + 1, new_value, item.enabled)
                if item.text == old_rule else item
                for item in current_v2.rules
            ]
            replacement_v2 = PreferenceGroupV2(
                current_v2.id, current_v2.revision + 1, current_v2.name, current_v2.description, rules,
            )
            self.write_groups_v2([replacement_v2 if item.name == group else item for item in groups])
            return replacement_v2.legacy_view()
        replacement = PreferenceGroup(
            current.name, current.description, [new_value if item == old_rule else item for item in current.rules],
        )
        self.write_groups([replacement if item.name == group else item for item in self.read_groups()])
        return replacement

    @_write_locked
    def delete_group_rule(self, group: str, rule: str) -> PreferenceGroup:
        current = self._require_group(group)
        if rule not in current.rules:
            raise PreferenceContractError(f"unknown preference rule in group: {group}")
        if self.groups_schema_version() == GROUPS_SCHEMA_VERSION_V2:
            groups = self.read_groups_v2()
            current_v2 = self._require_group_v2(group)
            replacement_v2 = PreferenceGroupV2(
                current_v2.id,
                current_v2.revision + 1,
                current_v2.name,
                current_v2.description,
                [item for item in current_v2.rules if item.text != rule],
            )
            self.write_groups_v2([replacement_v2 if item.name == group else item for item in groups])
            return replacement_v2.legacy_view()
        replacement = PreferenceGroup(current.name, current.description, [item for item in current.rules if item != rule])
        self.write_groups([replacement if item.name == group else item for item in self.read_groups()])
        return replacement

    @_write_locked
    def move_group_rule(self, source_group: str, target_group: str, rule: str) -> tuple[PreferenceGroup, PreferenceGroup]:
        source = self._require_group(source_group)
        target = self._require_group(target_group)
        if source_group == target_group:
            raise PreferenceContractError("source and target groups must differ")
        if rule not in source.rules:
            raise PreferenceContractError(f"unknown preference rule in source group: {source_group}")
        if rule in target.rules:
            raise PreferenceContractError(f"preference rule already exists in target group: {target_group}")
        if self.groups_schema_version() == GROUPS_SCHEMA_VERSION_V2:
            groups = self.read_groups_v2()
            source_v2 = self._require_group_v2(source_group)
            target_v2 = self._require_group_v2(target_group)
            moved = next(item for item in source_v2.rules if item.text == rule)
            updated_source_v2 = PreferenceGroupV2(
                source_v2.id, source_v2.revision + 1, source_v2.name, source_v2.description,
                [item for item in source_v2.rules if item.id != moved.id],
            )
            updated_target_v2 = PreferenceGroupV2(
                target_v2.id, target_v2.revision + 1, target_v2.name, target_v2.description,
                [*target_v2.rules, moved],
            )
            self.write_groups_v2([
                updated_source_v2 if item.id == source_v2.id
                else updated_target_v2 if item.id == target_v2.id
                else item
                for item in groups
            ])
            return updated_source_v2.legacy_view(), updated_target_v2.legacy_view()
        updated_source = PreferenceGroup(source.name, source.description, [item for item in source.rules if item != rule])
        updated_target = PreferenceGroup(target.name, target.description, [*target.rules, rule])
        self.write_groups([
            updated_source if item.name == source_group
            else updated_target if item.name == target_group
            else item
            for item in self.read_groups()
        ])
        return updated_source, updated_target

    def read_activations_document(self) -> GroupActivationDocument | GroupActivationDocumentV2:
        document = parse_activations_document_versioned(_read_json(self.activations_path, "group activations"))
        if not isinstance(document, GroupActivationDocumentV2):
            raise PreferenceIntegrityError("group activations must use schema_version=2")
        return document

    def read_activations(self) -> GroupActivationDocument:
        document = self.read_activations_document()
        if isinstance(document, GroupActivationDocument):
            return document
        by_id = {group.id: group.name for group in self.read_groups_v2()}
        return GroupActivationDocument(
            ACTIVATIONS_SCHEMA_VERSION_V1,
            {key: [by_id[item] for item in values if item in by_id] for key, values in document.directories.items()},
            {key: [by_id[item] for item in values if item in by_id] for key, values in document.sessions.items()},
        )

    @_write_locked
    def write_activations(self, document: GroupActivationDocument | dict[str, Any]) -> None:
        parsed = document if isinstance(document, GroupActivationDocument) else GroupActivationDocument.from_dict(document)
        if isinstance(self.read_activations_document(), GroupActivationDocumentV2):
            by_name = {group.name: group.id for group in self.read_groups_v2()}
            converted = GroupActivationDocumentV2(
                ACTIVATIONS_SCHEMA_VERSION_V2,
                {key: [by_name[item] for item in values if item in by_name] for key, values in parsed.directories.items()},
                {key: [by_name[item] for item in values if item in by_name] for key, values in parsed.sessions.items()},
            )
            atomic_write_text(self.activations_path, stable_json_dumps(converted.to_dict()) + "\n")
            return
        atomic_write_text(self.activations_path, stable_json_dumps(parsed.to_dict()) + "\n")

    def _activation_groups(self, values: Iterable[str]) -> list[str]:
        existing = set(self.group_names())
        return list(dict.fromkeys(group for group in values if group in existing))

    def directory_groups(self, directory: str) -> list[str]:
        if not isinstance(directory, str) or not directory.strip():
            raise PreferenceContractError("directory must be a non-empty string")
        return self._activation_groups(self.read_activations().directories.get(directory, []))

    def session_groups(self, session_id: str) -> list[str]:
        if not isinstance(session_id, str) or not session_id.strip():
            raise PreferenceContractError("session_id must be a non-empty string")
        return self._activation_groups(self.read_activations().sessions.get(session_id, []))

    @_write_locked
    def set_directory_group(self, directory: str, group: str, enabled: bool) -> list[str]:
        self._require_group(group)
        if group == "global":
            raise PreferenceContractError("the global preference group is always enabled")
        if not isinstance(directory, str) or not directory.strip():
            raise PreferenceContractError("directory must be a non-empty string")
        if not isinstance(enabled, bool):
            raise PreferenceContractError("enabled must be a boolean")
        document = self.read_activations()
        values = list(document.directories.get(directory, []))
        if enabled and group not in values:
            values.append(group)
        if not enabled:
            values = [item for item in values if item != group]
        directories = dict(document.directories)
        if values:
            directories[directory] = list(dict.fromkeys(values))
        else:
            directories.pop(directory, None)
        self.write_activations(GroupActivationDocument(ACTIVATIONS_SCHEMA_VERSION_V1, directories, dict(document.sessions)))
        return self.directory_groups(directory)

    @_write_locked
    def set_session_group(self, session_id: str, group: str, enabled: bool) -> list[str]:
        self._require_group(group)
        if group == "global":
            raise PreferenceContractError("the global preference group is always enabled")
        if not isinstance(session_id, str) or not session_id.strip():
            raise PreferenceContractError("session_id must be a non-empty string")
        if not isinstance(enabled, bool):
            raise PreferenceContractError("enabled must be a boolean")
        document = self.read_activations()
        values = list(document.sessions.get(session_id, []))
        if enabled and group not in values:
            values.append(group)
        if not enabled:
            values = [item for item in values if item != group]
        sessions = dict(document.sessions)
        if values:
            sessions[session_id] = list(dict.fromkeys(values))
        else:
            sessions.pop(session_id, None)
        self.write_activations(GroupActivationDocument(ACTIVATIONS_SCHEMA_VERSION_V1, dict(document.directories), sessions))
        return self.session_groups(session_id)

    def effective_group_names(self, directory: str, session_id: str) -> list[str]:
        groups = self.group_names()
        available = set(groups)
        result: list[str] = []
        if "global" in available:
            result.append("global")
        for name in [*self.directory_groups(directory), *self.session_groups(session_id)]:
            if name not in result:
                result.append(name)
        return result

    @_write_locked
    def append_inbox(self, event: PreferenceEvent, *, raw_diff: str | None = None) -> bool:
        raise PreferenceContractError("legacy feedback capture is unavailable; use feedback create")

    @_write_locked
    def append_evidence(
        self,
        event: PreferenceEvent,
        *,
        raw_diff: str | None = None,
        allow_duplicate_key: bool = False,
    ) -> bool:
        raise PreferenceContractError("legacy evidence append is unavailable; use learning-job complete")

    def _sanitized_event(self, event: PreferenceEvent) -> PreferenceEvent:
        for path in event.paths:
            safe = safe_relative_project_path(path)
            if path_is_denied(safe, DEFAULT_DENIED_FILE_NAMES):
                raise PreferenceIntegrityError(f"credential path is not allowed in evidence: {path}")
        sanitized = sanitize_text(event.summary)
        if sanitized.changed:
            return replace(event, summary=sanitized.text)
        return event

    def _check_event_privacy(self, event: PreferenceEvent) -> None:
        sanitized = self._sanitized_event(event)
        if sanitized != event:
            raise PreferenceIntegrityError("stored preference event is not sanitized")

    def _validate_raw_diff(self, raw_diff: str | None) -> None:
        if raw_diff is not None and not isinstance(raw_diff, str):
            raise PreferenceIntegrityError("raw diff must be a string")
        if raw_diff is not None and len(raw_diff.encode("utf-8")) > _MAX_RAW_DIFF_BYTES:
            raise PreferenceIntegrityError("raw diff exceeds 512 KiB")

    def _store_raw_diff(self, event: PreferenceEvent, raw_diff: str | None) -> None:
        if not raw_diff or not self.config.store_raw_diffs:
            return
        sanitized = sanitize_text(raw_diff)
        path = self.raw_diff_root / f"{event.id}.diff"
        write_once(path, sanitized.text.encode("utf-8"))

    def inbox_events(self) -> list[PreferenceEvent]:
        return self._all_local_events()

    @_write_locked
    def remove_inbox_group(self, group: str) -> int:
        events = self._all_local_events()
        removed = [event for event in events if event.group == group]
        if not removed:
            return 0
        kept = [event for event in events if event.group != group]
        content = "".join(stable_json_dumps(event.to_dict()) + "\n" for event in kept)
        atomic_write_text(self.inbox_path, content)
        for event in removed:
            path = self.raw_diff_root / f"{event.id}.diff"
            atomic_delete(path)
        return len(removed)

    def _all_local_events(self) -> list[PreferenceEvent]:
        rows = _read_jsonl(self.inbox_path, "local inbox")
        result: list[PreferenceEvent] = []
        for row in rows:
            event = PreferenceEvent.from_dict(row)
            self._check_event_privacy(event)
            result.append(event)
        return result

    def _evidence_rows(self) -> list[tuple[str, int, dict[str, Any]]]:
        result: list[tuple[str, int, dict[str, Any]]] = []
        for path in sorted(self.evidence_root.glob("*.jsonl")):
            if path.is_symlink() or not path.is_file():
                raise PreferenceIntegrityError(f"unsafe evidence file: {path}")
            rows = _read_jsonl(path, "evidence")
            for index, row in enumerate(rows, 1):
                result.append((path.name, index, row))
        return result

    def evidence_events(self) -> list[PreferenceEvent]:
        return self._all_evidence_events()

    def _all_evidence_events(self) -> list[PreferenceEvent]:
        result: list[PreferenceEvent] = []
        for _name, _line, row in self._evidence_rows():
            event = PreferenceEvent.from_dict(row)
            self._check_event_privacy(event)
            result.append(event)
        return result

    def current_evidence_cursors(self) -> dict[str, int]:
        cursors: dict[str, int] = {}
        for name, line_number, _row in self._evidence_rows():
            cursors[name] = max(cursors.get(name, 0), line_number)
        return cursors

    def load_new_evidence(self) -> tuple[list[PreferenceEvent], dict[str, int]]:
        version = self.read_version()
        cursors = {str(key): int(value) for key, value in version["evidence_cursors"].items()}
        events: list[PreferenceEvent] = []
        current: dict[str, int] = {}
        group_names = self.group_names()
        for name, line_number, row in self._evidence_rows():
            current[name] = max(current.get(name, 0), line_number)
            if line_number <= cursors.get(name, 0):
                continue
            event = PreferenceEvent.from_dict(row)
            self._check_event_privacy(event)
            if event.group in group_names and event.signal is not Signal.REMEMBER:
                events.append(event)
        for path in sorted(self.evidence_root.glob("*.jsonl")):
            current.setdefault(path.name, len(_read_jsonl(path, "evidence")))
        return events, current

    @_write_locked
    def sync_inbox(self) -> dict[str, int]:
        raise PreferenceContractError("legacy inbox sync is unavailable; use feedback jobs")

    @_write_locked
    def append_metric(self, value: dict[str, Any]) -> None:
        _append_jsonl(self.metrics_path, {"created_at": utc_now(), **value})

    @_write_locked
    def write_last_run(self, value: dict[str, Any]) -> None:
        atomic_write_text(self.last_run_path, stable_json_dumps(value) + "\n")

    def local_event_count(self) -> int:
        return len(self._all_local_events())

    def evidence_count(self) -> int:
        return len(self._all_evidence_events())
