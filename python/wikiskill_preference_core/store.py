"""Local evidence and personal preference group storage."""

from __future__ import annotations

import json
import os
import secrets
import tempfile
from dataclasses import replace
from pathlib import Path
from typing import Any, Iterable

from .config import PreferenceConfig, default_config
from .contracts import (
    GroupActivationDocument,
    PreferenceEvent,
    PreferenceGroup,
    PreferenceGroupsDocument,
    Signal,
    groups_document,
    parse_activations_document,
    parse_groups_document,
    stable_json_dumps,
    utc_now,
)
from .errors import PreferenceContractError, PreferenceIntegrityError, PreferenceStorageError
from .sanitizing import DEFAULT_DENIED_FILE_NAMES, path_is_denied, sanitize_text, safe_relative_project_path

DEVICE_KEYS = {"schema_version", "device_id"}
VERSION_KEYS = {"schema_version", "generator_version", "generated_at", "evidence_cursors", "model"}
ACTIVATIONS_DEFAULT = {"schema_version": 1, "directories": {}, "sessions": {}}
GENERATOR_VERSION = "wikiskill-personal-preferences/1"
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


def atomic_write_bytes(path: Path, content: bytes) -> None:
    """Write a file with fsync and an atomic replace in its parent directory."""

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
    line = stable_json_dumps(value) + "\n"
    try:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise PreferenceStorageError(f"cannot append {path}: {exc}") from exc


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
        root = Path(data_root).resolve()
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
            store = cls(root)
            store._initialize_files(config)
            return store
        except Exception:
            if created_config and config_path.is_file() and not config_path.is_symlink():
                config_path.unlink()
            raise

    def _validate_layout(self) -> None:
        _regular_directory(self.root)
        _regular_directory(self.local)
        _regular_directory(self.repo)
        _regular_directory(self.repo / "evidence")

    def _initialize_files(self, config: PreferenceConfig) -> None:
        from .git_sync import begin_generated_transaction, restore_generated_transaction

        transaction = begin_generated_transaction(
            self.repo,
            extra_paths=(self.device_path, self.local_root),
        )
        try:
            self._initialize_files_unchecked(config)
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
            self.read_groups()
        else:
            self.write_groups([
                PreferenceGroup(
                    name="global",
                    description="适用于所有 Pi 会话的通用个人偏好。",
                    rules=[],
                ),
            ])

        if self.activations_path.exists():
            self.read_activations()
        else:
            atomic_write_text(self.activations_path, stable_json_dumps(ACTIVATIONS_DEFAULT) + "\n")

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
        return {
            "schema_version": 1,
            "generator_version": GENERATOR_VERSION,
            "generated_at": utc_now(),
            "evidence_cursors": {},
            "model": None,
        }

    def read_version(self) -> dict[str, Any]:
        value = _read_json(self.version_path, "version")
        if not isinstance(value, dict) or set(value) != VERSION_KEYS:
            raise PreferenceIntegrityError("version.json has an invalid shape")
        if (
            type(value.get("schema_version")) is not int
            or value.get("schema_version") != 1
            or value.get("generator_version") != GENERATOR_VERSION
        ):
            raise PreferenceIntegrityError("version.json has an unsupported schema or generator")
        if value.get("model") is not None and not isinstance(value.get("model"), str):
            raise PreferenceIntegrityError("version model must be a string or null")
        cursors = value.get("evidence_cursors")
        if not isinstance(cursors, dict) or any(
            not isinstance(key, str) or type(item) is not int or item < 0
            for key, item in cursors.items()
        ):
            raise PreferenceIntegrityError("version evidence cursors are invalid")
        return value

    def write_version(self, *, cursors: dict[str, int], model: str | None) -> None:
        value = {
            "schema_version": 1,
            "generator_version": GENERATOR_VERSION,
            "generated_at": utc_now(),
            "evidence_cursors": {key: int(cursors[key]) for key in sorted(cursors)},
            "model": model,
        }
        atomic_write_text(self.version_path, stable_json_dumps(value) + "\n")

    def read_groups(self) -> list[PreferenceGroup]:
        groups = parse_groups_document(_read_json(self.groups_path, "preference groups"))
        for group in groups:
            if sanitize_text(group.description).changed or any(sanitize_text(rule).changed for rule in group.rules):
                raise PreferenceIntegrityError("stored preference group is not sanitized")
        return groups

    def write_groups(self, groups: Iterable[PreferenceGroup] | PreferenceGroupsDocument) -> None:
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

    def create_group(self, name: str, description: str) -> PreferenceGroup:
        raw_group = PreferenceGroup.from_dict({"name": name, "description": description, "rules": []})
        group = PreferenceGroup.from_dict({
            "name": raw_group.name,
            "description": sanitize_text(raw_group.description).text,
            "rules": [],
        })
        groups = self.read_groups()
        if any(item.name == group.name for item in groups):
            raise PreferenceContractError(f"preference group already exists: {group.name}")
        self.write_groups([*groups, group])
        return group

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
        self.write_groups([validated if group.name == name else group for group in self.read_groups()])
        return validated

    def delete_group(self, name: str) -> PreferenceGroup:
        group = self._require_group(name)
        self.write_groups([item for item in self.read_groups() if item.name != name])
        self.remove_inbox_group(name)
        return group

    def add_group_rule(self, group: str, rule: str) -> PreferenceGroup:
        current = self._require_group(group)
        raw_group = PreferenceGroup.from_dict({"name": group, "description": current.description, "rules": [rule]})
        validated = PreferenceGroup.from_dict({
            "name": raw_group.name,
            "description": current.description,
            "rules": [sanitize_text(raw_group.rules[0]).text],
        })
        if validated.rules[0] in current.rules:
            raise PreferenceContractError(f"preference rule already exists in group: {group}")
        replacement = PreferenceGroup(current.name, current.description, [*current.rules, validated.rules[0]])
        self.write_groups([replacement if item.name == group else item for item in self.read_groups()])
        return replacement

    def update_group_rule(self, group: str, old_rule: str, new_rule: str) -> PreferenceGroup:
        current = self._require_group(group)
        if old_rule not in current.rules:
            raise PreferenceContractError(f"unknown preference rule in group: {group}")
        raw_group = PreferenceGroup.from_dict({"name": group, "description": current.description, "rules": [new_rule]})
        validated = PreferenceGroup.from_dict({
            "name": raw_group.name,
            "description": current.description,
            "rules": [sanitize_text(raw_group.rules[0]).text],
        })
        new_value = validated.rules[0]
        if new_value != old_rule and new_value in current.rules:
            raise PreferenceContractError(f"preference rule already exists in group: {group}")
        rules = [new_value if item == old_rule else item for item in current.rules]
        replacement = PreferenceGroup(current.name, current.description, rules)
        self.write_groups([replacement if item.name == group else item for item in self.read_groups()])
        return replacement

    def delete_group_rule(self, group: str, rule: str) -> PreferenceGroup:
        current = self._require_group(group)
        if rule not in current.rules:
            raise PreferenceContractError(f"unknown preference rule in group: {group}")
        replacement = PreferenceGroup(current.name, current.description, [item for item in current.rules if item != rule])
        self.write_groups([replacement if item.name == group else item for item in self.read_groups()])
        return replacement

    def move_group_rule(self, source_group: str, target_group: str, rule: str) -> tuple[PreferenceGroup, PreferenceGroup]:
        source = self._require_group(source_group)
        target = self._require_group(target_group)
        if source_group == target_group:
            raise PreferenceContractError("source and target groups must differ")
        if rule not in source.rules:
            raise PreferenceContractError(f"unknown preference rule in source group: {source_group}")
        if rule in target.rules:
            raise PreferenceContractError(f"preference rule already exists in target group: {target_group}")
        updated_source = PreferenceGroup(source.name, source.description, [item for item in source.rules if item != rule])
        updated_target = PreferenceGroup(target.name, target.description, [*target.rules, rule])
        self.write_groups([
            updated_source if item.name == source_group
            else updated_target if item.name == target_group
            else item
            for item in self.read_groups()
        ])
        return updated_source, updated_target

    def read_activations(self) -> GroupActivationDocument:
        return parse_activations_document(_read_json(self.activations_path, "group activations"))

    def write_activations(self, document: GroupActivationDocument | dict[str, Any]) -> None:
        parsed = document if isinstance(document, GroupActivationDocument) else GroupActivationDocument.from_dict(document)
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
        self.write_activations(GroupActivationDocument(1, directories, dict(document.sessions)))
        return self.directory_groups(directory)

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
        self.write_activations(GroupActivationDocument(1, dict(document.directories), sessions))
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

    def append_inbox(self, event: PreferenceEvent, *, raw_diff: str | None = None) -> bool:
        event.validate_for(self.group_names())
        event = self._sanitized_event(event)
        self._validate_raw_diff(raw_diff)
        existing = [*self._all_local_events(), *self._all_evidence_events()]
        key = _unique_event_key(event)
        if any(_unique_event_key(item) == key or item.id == event.id for item in existing):
            return False
        _append_jsonl(self.inbox_path, event.to_dict())
        self._store_raw_diff(event, raw_diff)
        return True

    def append_evidence(
        self,
        event: PreferenceEvent,
        *,
        raw_diff: str | None = None,
        allow_duplicate_key: bool = False,
    ) -> bool:
        event.validate_for(self.group_names())
        event = self._sanitized_event(event)
        self._validate_raw_diff(raw_diff)
        existing = [*self._all_evidence_events(), *self._all_local_events()]
        key = _unique_event_key(event)
        if any(item.id == event.id for item in existing):
            return False
        if not allow_duplicate_key and any(_unique_event_key(item) == key for item in existing):
            return False
        path = self.evidence_root / f"{self.device_id()}.jsonl"
        _append_jsonl(path, event.to_dict())
        self._store_raw_diff(event, raw_diff)
        return True

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
            if path.is_symlink():
                raise PreferenceIntegrityError(f"symlink is not allowed: {path}")
            path.unlink(missing_ok=True)
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

    def sync_inbox(self) -> dict[str, int]:
        rows = _read_jsonl(self.inbox_path, "local inbox")
        synced = 0
        discarded = 0
        existing = self._all_evidence_events()
        keys = {_unique_event_key(event) for event in existing}
        ids = {event.id for event in existing}
        device_file = self.evidence_root / f"{self.device_id()}.jsonl"
        group_names = self.group_names()
        for row in rows:
            event = PreferenceEvent.from_dict(row)
            self._check_event_privacy(event)
            if event.group not in group_names:
                discarded += 1
                raw_diff = self.raw_diff_root / f"{event.id}.diff"
                if raw_diff.is_symlink():
                    raise PreferenceIntegrityError(f"symlink is not allowed: {raw_diff}")
                raw_diff.unlink(missing_ok=True)
                continue
            key = _unique_event_key(event)
            if key in keys or event.id in ids:
                if key in keys and event.id not in ids:
                    raw_diff = self.raw_diff_root / f"{event.id}.diff"
                    if raw_diff.is_symlink():
                        raise PreferenceIntegrityError(f"symlink is not allowed: {raw_diff}")
                    raw_diff.unlink(missing_ok=True)
                continue
            _append_jsonl(device_file, event.to_dict())
            keys.add(key)
            ids.add(event.id)
            synced += 1
        atomic_write_text(self.inbox_path, "")
        return {"synced": synced, "discarded": discarded}

    def append_metric(self, value: dict[str, Any]) -> None:
        _append_jsonl(self.metrics_path, {"created_at": utc_now(), **value})

    def write_last_run(self, value: dict[str, Any]) -> None:
        atomic_write_text(self.last_run_path, stable_json_dumps(value) + "\n")

    def local_event_count(self) -> int:
        return len(self._all_local_events())

    def evidence_count(self) -> int:
        return len(self._all_evidence_events())
