#!/usr/bin/env python3
"""CLI for the independent personal-preference group mode."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from wikiskill_preference_core.classification import (  # noqa: E402
    PROMPT_VERSION as CLASSIFICATION_PROMPT_VERSION,
    classify_group,
)
from wikiskill_preference_core.config import PreferenceConfig  # noqa: E402
from wikiskill_preference_core.contracts import (  # noqa: E402
    GroupClassificationRequest,
    PreferenceEvent,
    PreferenceGroup,
    Signal,
    new_id,
    stable_json_dumps,
    utc_now,
)
from wikiskill_preference_core.errors import PreferenceError, PreferenceGitError  # noqa: E402
from wikiskill_preference_core.evolution import evolve_preferences  # noqa: E402
from wikiskill_preference_core.git_sync import (  # noqa: E402
    begin_generated_transaction,
    commit_generated,
    initialize_commit,
    pull_rebase,
    push,
    repository_head,
    restore_generated_transaction,
    rollback as git_rollback,
    sync_state,
)
from wikiskill_preference_core.sanitizing import (  # noqa: E402
    DEFAULT_DENIED_FILE_NAMES,
    path_is_denied,
    sanitize_text,
    safe_relative_project_path,
)
from wikiskill_preference_core.store import PreferenceStore, atomic_write_text  # noqa: E402

_MAX_RAW_DIFF_BYTES = 512 * 1024


def default_data_root() -> Path:
    override = os.environ.get("PI_PREFERENCE_DATA_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", "~/.pi/agent")).expanduser()
    return (agent_dir / "personal-preferences").resolve()


def _json_input() -> Any:
    try:
        text = sys.stdin.read()
    except OSError as exc:
        raise PreferenceError(f"cannot read stdin: {exc}") from exc
    if not text.strip():
        raise PreferenceError("stdin must contain a JSON object")
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PreferenceError(f"stdin is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise PreferenceError("stdin JSON must be an object")
    return value


def _event_from_input(value: dict[str, Any]) -> tuple[PreferenceEvent, str | None]:
    event_data = dict(value)
    raw_diff = event_data.pop("diff", None)
    event_data.setdefault("id", new_id("evt-"))
    event_data.setdefault("created_at", utc_now())
    event_data.setdefault("schema_version", 1)
    event_data.setdefault("paths", [])
    if "summary" not in event_data or not isinstance(event_data["summary"], str):
        raise PreferenceError("event.summary must be a string")
    event_data["summary"] = sanitize_text(event_data["summary"]).text
    try:
        event = PreferenceEvent.from_dict(event_data)
    except ValueError as exc:
        raise PreferenceError(f"event is invalid: {exc}") from exc
    if raw_diff is not None and not isinstance(raw_diff, str):
        raise PreferenceError("diff must be a string when present")
    if raw_diff is not None and len(raw_diff.encode("utf-8")) > _MAX_RAW_DIFF_BYTES:
        raise PreferenceError("diff exceeds 512 KiB")
    return event, raw_diff


def _push_result(store: PreferenceStore, *, requested: bool) -> dict[str, Any]:
    if not requested:
        return {"pushed": False}
    try:
        return {"pushed": push(store.repo)}
    except PreferenceGitError as exc:
        return {
            "pushed": False,
            "push_error": sanitize_text(str(exc)).text[:500],
        }


def _mark_local_evidence_processed(store: PreferenceStore, previous_line_count: int) -> None:
    version = store.read_version()
    cursors = dict(version["evidence_cursors"])
    own_name = f"{store.device_id()}.jsonl"
    if cursors.get(own_name, 0) != previous_line_count:
        return
    cursors[own_name] = store.current_evidence_cursors().get(own_name, previous_line_count)
    store.write_version(cursors=cursors, model=version.get("model"))


def _groups_output(store: PreferenceStore) -> dict[str, Any]:
    groups = store.read_groups()
    return {"ok": True, "groups": [group.to_dict() for group in groups]}


def _capture(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    if not store.config.enabled:
        return {"ok": True, "stored": False, "disabled": True}
    event, raw_diff = _event_from_input(value)
    added = store.append_inbox(event, raw_diff=raw_diff)
    return {
        "ok": True,
        "event_id": event.id,
        "stored": added,
        "location": "local/inbox.jsonl",
        "group": event.group,
    }


def _classification_request(store: PreferenceStore, value: dict[str, Any]) -> GroupClassificationRequest:
    request = GroupClassificationRequest.from_dict(value)
    request.validate_for(store.group_names())
    return request


def _classify_group(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    request = _classification_request(store, value)
    diagnostics: list[str] = []
    try:
        result = classify_group(store.config, request, diagnostics=diagnostics)
    except PreferenceError as exc:
        store.write_last_run({
            "ok": False,
            "stage": "classification",
            "model": f"{store.config.provider['name']}/{store.config.provider['model']}",
            "prompt_version": CLASSIFICATION_PROMPT_VERSION,
            "error": sanitize_text(str(exc)).text[:500],
        })
        raise
    store.write_last_run({
        "ok": True,
        "stage": "classification",
        "group": result.group,
        "model": f"{store.config.provider['name']}/{store.config.provider['model']}",
        "prompt_version": CLASSIFICATION_PROMPT_VERSION,
        **({"diagnostics": diagnostics} if diagnostics else {}),
    })
    return result.to_dict()


def _remember(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    if not store.config.enabled:
        raise PreferenceError("personal preference system is disabled")
    allowed = {"group", "rule", "task_id"}
    required = {"group", "rule"}
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise PreferenceError(f"remember input missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceError(f"remember input has unknown keys: {sorted(unknown)}")
    group = value["group"]
    rule = value["rule"]
    if not isinstance(group, str) or not group.strip():
        raise PreferenceError("remember.group must be a non-empty string")
    if not isinstance(rule, str) or not rule.strip():
        raise PreferenceError("remember.rule must be a non-empty string")
    task_id = value.get("task_id")
    if task_id is not None and (not isinstance(task_id, str) or not task_id.strip()):
        raise PreferenceError("remember.task_id must be a non-empty string or null")
    current = store._require_group(group)
    normalized_rule = PreferenceGroup.from_dict({
        "name": group,
        "description": current.description,
        "rules": [sanitize_text(rule).text],
    }).rules[0]
    if normalized_rule in current.rules:
        return {
            "ok": True,
            "group": group,
            "rule": normalized_rule,
            "duplicate": True,
            "commit": None,
            "pushed": False,
            "sync_state": sync_state(store.repo),
        }
    event = PreferenceEvent.from_dict({
        "schema_version": 1,
        "id": new_id("evt-"),
        "created_at": utc_now(),
        "group": group,
        "signal": Signal.REMEMBER.value,
        "summary": normalized_rule,
        "task_id": task_id,
        "paths": [],
    })
    restored = any(
        item.group == group and item.signal is Signal.REMEMBER and item.summary == normalized_rule
        for item in [*store.evidence_events(), *store.inbox_events()]
    )
    own_name = f"{store.device_id()}.jsonl"
    previous_line_count = store.current_evidence_cursors().get(own_name, 0)
    transaction = begin_generated_transaction(store.repo)
    try:
        if not store.append_evidence(event, allow_duplicate_key=True):
            raise PreferenceError("remember evidence ID already exists")
        store.add_group_rule(group, normalized_rule)
        _mark_local_evidence_processed(store, previous_line_count)
        commit = commit_generated(store.repo, "personal-preferences: remember")
        if not commit:
            raise PreferenceGitError("remember did not create a Git commit")
    except Exception:
        restore_generated_transaction(transaction)
        raise
    push_result = _push_result(store, requested=store.config.git_auto_push)
    store.append_metric({"kind": "remember", "group": group, "rules": store.rule_count()})
    return {
        "ok": True,
        "event_id": event.id,
        "group": group,
        "rule": normalized_rule,
        "duplicate": False,
        "restored": restored,
        "commit": commit,
        **push_result,
        "sync_state": sync_state(store.repo),
    }


def _diff_line_counts(raw_diff: str) -> tuple[int, int]:
    added = sum(line.startswith("+") and not line.startswith("+++") for line in raw_diff.splitlines())
    removed = sum(line.startswith("-") and not line.startswith("---") for line in raw_diff.splitlines())
    return added, removed


def _changed(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    if not store.config.enabled:
        return {"ok": True, "changed": False, "stored": False, "disabled": True, "events": []}
    required = {"task_id", "paths", "agent_hashes", "current_hashes", "task_summary"}
    allowed = required | {"diffs", "summary"}
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise PreferenceError(f"changed input missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceError(f"changed input has unknown keys: {sorted(unknown)}")
    task_id = value["task_id"]
    if not isinstance(task_id, str) or not task_id.strip():
        raise PreferenceError("changed.task_id must be a non-empty string")
    task_summary = value["task_summary"]
    if not isinstance(task_summary, str):
        raise PreferenceError("changed.task_summary must be a string")
    paths = value["paths"]
    if not isinstance(paths, list):
        raise PreferenceError("changed.paths must be a list")
    agent_hashes = value["agent_hashes"]
    current_hashes = value["current_hashes"]
    if not isinstance(agent_hashes, dict) or not isinstance(current_hashes, dict):
        raise PreferenceError("changed hash maps must be objects")
    for label, hashes in (("agent_hashes", agent_hashes), ("current_hashes", current_hashes)):
        if any(
            not isinstance(path, str)
            or not isinstance(digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", digest)
            for path, digest in hashes.items()
        ):
            raise PreferenceError(f"changed.{label} must map paths to SHA-256 hex digests")
    selected: list[str] = []
    seen_paths: set[str] = set()
    for raw_path in paths:
        if not isinstance(raw_path, str):
            raise PreferenceError("changed.paths must contain strings")
        path = safe_relative_project_path(raw_path)
        if path_is_denied(path, DEFAULT_DENIED_FILE_NAMES):
            continue
        if path in seen_paths:
            raise PreferenceError("changed.paths must not contain duplicates")
        seen_paths.add(path)
        if path not in agent_hashes or path not in current_hashes:
            raise PreferenceError(f"changed hash maps are missing path: {path}")
        if agent_hashes[path] != current_hashes[path]:
            selected.append(path)
    if not selected:
        return {"ok": True, "changed": False, "stored": False, "events": []}

    diffs = value.get("diffs")
    raw_diff: str | None = None
    if isinstance(diffs, dict):
        if any(path in diffs and not isinstance(diffs[path], str) for path in selected):
            raise PreferenceError("changed.diffs values must be strings")
        raw_diff = "\n".join(diffs[path] for path in selected if path in diffs)
    elif diffs is not None:
        raise PreferenceError("changed.diffs must be an object when present")
    if raw_diff is not None and len(raw_diff.encode("utf-8")) > _MAX_RAW_DIFF_BYTES:
        raise PreferenceError("changed.diffs exceeds 512 KiB")

    summary = value.get("summary")
    if summary is not None and not isinstance(summary, str):
        raise PreferenceError("changed.summary must be a string when present")
    if not isinstance(summary, str) or not summary.strip():
        summary = "用户修改了 Agent 生成的产物：" + ", ".join(selected)
        if raw_diff:
            added, removed = _diff_line_counts(raw_diff)
            summary += f"（最小 diff：+{added}/-{removed} 行）"
    summary = sanitize_text(summary).text
    request = GroupClassificationRequest.from_dict({
        "schema_version": 1,
        "preference_text": summary,
        "task_summary": sanitize_text(task_summary).text,
        "touched_paths": selected,
        "groups": [
            {"name": group.name, "description": group.description}
            for group in store.read_groups()
        ],
    })
    try:
        classification = classify_group(store.config, request)
    except PreferenceError as exc:
        store.write_last_run({
            "ok": False,
            "stage": "changed_classification",
            "error": sanitize_text(str(exc)).text[:500],
        })
        return {
            "ok": True,
            "changed": False,
            "stored": False,
            "classified": False,
            "events": [],
        }

    event = PreferenceEvent.from_dict({
        "schema_version": 1,
        "id": new_id("evt-"),
        "created_at": utc_now(),
        "group": classification.group,
        "signal": Signal.USER_EDIT.value,
        "summary": summary,
        "task_id": task_id,
        "paths": selected,
    })
    added = store.append_inbox(event, raw_diff=raw_diff)
    return {
        "ok": True,
        "changed": added,
        "stored": added,
        "classified": True,
        "group": event.group,
        "events": [event.id] if added else [],
    }


def _manage_group(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    action = value.get("action")
    if not isinstance(action, str) or not action.strip():
        raise PreferenceError("manage-group requires action")
    specs: dict[str, tuple[set[str], set[str]]] = {
        "create": ({"action", "name", "description"}, {"action", "name", "description"}),
        "update_description": ({"action", "group", "description"}, {"action", "group", "description"}),
        "delete": ({"action", "group"}, {"action", "group"}),
        "add_rule": ({"action", "group", "rule"}, {"action", "group", "rule"}),
        "update_rule": ({"action", "group", "rule", "replacement"}, {"action", "group", "rule", "replacement"}),
        "delete_rule": ({"action", "group", "rule"}, {"action", "group", "rule"}),
        "move_rule": ({"action", "source_group", "target_group", "rule"}, {"action", "source_group", "target_group", "rule"}),
    }
    if action not in specs:
        raise PreferenceError(f"manage-group action is unsupported: {action}")
    required, allowed = specs[action]
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise PreferenceError(f"manage-group {action} missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceError(f"manage-group {action} has unknown keys: {sorted(unknown)}")

    before = store.groups_path.read_text(encoding="utf-8")
    transaction = begin_generated_transaction(
        store.repo,
        extra_paths=(store.inbox_path, store.raw_diff_root),
    )
    try:
        if action == "create":
            group = store.create_group(value["name"], value["description"])
            result_group = group.name
        elif action == "update_description":
            group = store.update_group_description(value["group"], value["description"])
            result_group = group.name
        elif action == "delete":
            group = store.delete_group(value["group"])
            result_group = group.name
        elif action == "add_rule":
            group = store.add_group_rule(value["group"], value["rule"])
            result_group = group.name
        elif action == "update_rule":
            group = store.update_group_rule(value["group"], value["rule"], value["replacement"])
            result_group = group.name
        elif action == "delete_rule":
            group = store.delete_group_rule(value["group"], value["rule"])
            result_group = group.name
        else:
            _source, target = store.move_group_rule(value["source_group"], value["target_group"], value["rule"])
            result_group = target.name

        changed = before != store.groups_path.read_text(encoding="utf-8")
        commit = commit_generated(store.repo, f"personal-preferences: group {action}") if changed else None
        if changed and not commit:
            raise PreferenceGitError("preference group change did not create a Git commit")
    except Exception:
        restore_generated_transaction(transaction)
        raise
    push_result = _push_result(store, requested=bool(commit and store.config.git_auto_push))
    return {
        "ok": True,
        "action": action,
        "group": result_group,
        "groups": [group.to_dict() for group in store.read_groups()],
        "changed": changed,
        "commit": commit,
        **push_result,
        "sync_state": sync_state(store.repo),
    }


def _set_activation(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    allowed = {"target", "key", "group", "enabled"}
    required = allowed
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise PreferenceError(f"set-activation input missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceError(f"set-activation input has unknown keys: {sorted(unknown)}")
    target = value["target"]
    key = value["key"]
    group = value["group"]
    enabled = value["enabled"]
    if target not in {"directory", "session"}:
        raise PreferenceError("set-activation.target must be directory or session")
    if not isinstance(key, str) or not key.strip():
        raise PreferenceError("set-activation.key must be a non-empty string")
    if not isinstance(group, str) or not group.strip():
        raise PreferenceError("set-activation.group must be a non-empty string")
    if not isinstance(enabled, bool):
        raise PreferenceError("set-activation.enabled must be a boolean")
    active = (
        store.set_directory_group(key, group, enabled)
        if target == "directory"
        else store.set_session_group(key, group, enabled)
    )
    return {"ok": True, "target": target, "key": key, "group": group, "enabled": enabled, "groups": active}


def _context(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    allowed = {"directory", "session_id"}
    missing = allowed - set(value)
    unknown = set(value) - allowed
    if missing:
        raise PreferenceError(f"context input missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceError(f"context input has unknown keys: {sorted(unknown)}")
    directory = value["directory"]
    session_id = value["session_id"]
    if not isinstance(directory, str) or not directory.strip():
        raise PreferenceError("context.directory must be a non-empty string")
    if not isinstance(session_id, str) or not session_id.strip():
        raise PreferenceError("context.session_id must be a non-empty string")
    return {
        "ok": True,
        "effective_groups": store.effective_group_names(directory, session_id),
        "directory_groups": store.directory_groups(directory),
        "session_groups": store.session_groups(session_id),
    }


def _settings(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    allowed = {"enabled", "auto_evolve", "git_auto_push"}
    if not value:
        raise PreferenceError("settings requires at least one setting")
    unknown = set(value) - allowed
    if unknown:
        raise PreferenceError(f"settings contains unknown keys: {sorted(unknown)}")
    if any(not isinstance(value[key], bool) for key in value):
        raise PreferenceError("settings values must be booleans")
    data = store.config.to_dict()
    data.update(value)
    config = PreferenceConfig.from_dict(data, store.root)
    atomic_write_text(store.root / "config.json", stable_json_dumps(config.to_dict()) + "\n")
    return {
        "ok": True,
        "enabled": config.enabled,
        "auto_evolve": config.auto_evolve,
        "git_auto_push": config.git_auto_push,
    }


def _pending_evidence(store: PreferenceStore) -> list[PreferenceEvent]:
    new_events, _cursors = store.load_new_evidence()
    new_events.extend(store.inbox_events())
    return sorted({event.id: event for event in new_events}.values(), key=lambda item: item.id)


def _status(store: PreferenceStore) -> dict[str, Any]:
    pending = _pending_evidence(store)
    model_ready, model_status = store.config.model_readiness()
    provider = store.config.provider
    is_fake = provider["name"] == "fake"
    base_url_ready = is_fake or bool(provider.get("base_url") or os.environ.get("OPENAI_BASE_URL"))
    credential_env = str(provider["api_key_env"])
    credential_ready = is_fake or bool(os.environ.get(credential_env))
    return {
        "ok": True,
        "enabled": store.config.enabled,
        "auto_evolve": store.config.auto_evolve,
        "groups": store.group_count(),
        "rules": store.rule_count(),
        "pending_evidence_count": len(pending),
        "evolve_due": store.config.enabled and model_ready and len(pending) >= store.config.auto_evolve_after,
        "model_ready": model_ready,
        "model_status": model_status,
        "provider_name": provider["name"],
        "provider_model": provider["model"],
        "provider_base_url_ready": base_url_ready,
        "provider_credential_env": credential_env,
        "provider_credential_ready": credential_ready,
        "sync_state": sync_state(store.repo),
    }


def _sync(store: PreferenceStore) -> dict[str, Any]:
    transaction = begin_generated_transaction(
        store.repo,
        extra_paths=(store.inbox_path, store.raw_diff_root),
    )
    try:
        inbox = store.sync_inbox()
        evidence_commit = commit_generated(store.repo, "personal-preferences: evidence sync") if inbox["synced"] else None
    except Exception:
        restore_generated_transaction(transaction)
        raise
    pulled = pull_rebase(store.repo)
    push_result = _push_result(store, requested=True)
    return {
        "ok": True,
        **inbox,
        "groups": [group.to_dict() for group in store.read_groups()],
        "evidence_commit": evidence_commit,
        "pulled": pulled,
        **push_result,
        "git_head": repository_head(store.repo),
        "sync_state": sync_state(store.repo),
    }


def build_parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(
        prog="wikiskill-preference",
        description="Manage personal preference groups independently of faithful WikiSkill.",
    )
    root.add_argument("--json", action="store_true", dest="json_output", help="emit machine-readable JSON")
    commands = root.add_subparsers(dest="command", required=True)

    def data_root(parser: argparse.ArgumentParser) -> None:
        parser.add_argument("--data-root", default=str(default_data_root()))

    init = commands.add_parser("init", help="initialize the personal preference directory and Git repository")
    data_root(init)
    init.add_argument("--json", action="store_true", dest="json_output")

    groups = commands.add_parser("groups", help="list preference groups")
    data_root(groups)

    manage = commands.add_parser("manage-group", help="create or modify a preference group through stdin")
    data_root(manage)
    manage.add_argument("--stdin", action="store_true", required=True)

    activation = commands.add_parser("set-activation", help="enable or disable a group for a directory or session")
    data_root(activation)
    activation.add_argument("--stdin", action="store_true", required=True)

    context = commands.add_parser("context", help="read effective groups for a directory and session")
    data_root(context)
    context.add_argument("--stdin", action="store_true", required=True)

    capture = commands.add_parser("capture", help="capture a validated group event through stdin")
    data_root(capture)
    capture.add_argument("--stdin", action="store_true", required=True)

    changed = commands.add_parser("changed", help="record touched-file user edits through stdin")
    data_root(changed)
    changed.add_argument("--stdin", action="store_true", required=True)

    remember = commands.add_parser("remember", help="write a rule to an existing group through stdin")
    data_root(remember)
    remember.add_argument("--stdin", action="store_true", required=True)

    classify = commands.add_parser("classify-group", help="classify a preference into an existing group through stdin")
    data_root(classify)
    classify.add_argument("--stdin", action="store_true", required=True)

    evolve = commands.add_parser("evolve", help="update group rules from new evidence")
    data_root(evolve)
    evolve.add_argument("--dry-run", action="store_true")

    status = commands.add_parser("status", help="show personal preference group status")
    data_root(status)
    status.add_argument("--json", action="store_true", dest="json_output")

    settings = commands.add_parser("settings", help="update allowed preference settings through stdin")
    data_root(settings)
    settings.add_argument("--stdin", action="store_true", required=True)

    sync = commands.add_parser("sync", help="commit evidence and synchronize the private preference repository")
    data_root(sync)

    rollback = commands.add_parser("rollback", help="revert the latest generated preference Git commit")
    data_root(rollback)
    rollback.add_argument("--commit")
    return root


def dispatch(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "init":
        store = PreferenceStore.init(args.data_root)
        commit = initialize_commit(store.repo) or repository_head(store.repo)
        return {
            "ok": True,
            "data_root": str(store.root),
            "repo": str(store.repo),
            "device_id": store.device_id(),
            "commit": commit,
            "stage": "initialized",
        }
    store = PreferenceStore(args.data_root)
    if args.command == "groups":
        return _groups_output(store)
    if args.command == "manage-group":
        return _manage_group(store, _json_input())
    if args.command == "set-activation":
        return _set_activation(store, _json_input())
    if args.command == "context":
        return _context(store, _json_input())
    if args.command == "capture":
        return _capture(store, _json_input())
    if args.command == "changed":
        return _changed(store, _json_input())
    if args.command == "remember":
        return _remember(store, _json_input())
    if args.command == "classify-group":
        return _classify_group(store, _json_input())
    if args.command == "evolve":
        return evolve_preferences(store.root, dry_run=args.dry_run)
    if args.command == "status":
        return _status(store)
    if args.command == "settings":
        return _settings(store, _json_input())
    if args.command == "sync":
        return _sync(store)
    if args.command == "rollback":
        commit = git_rollback(store.repo, args.commit)
        push_result = _push_result(store, requested=store.config.git_auto_push)
        return {
            "ok": True,
            "commit": commit,
            **push_result,
            "sync_state": sync_state(store.repo),
        }
    raise PreferenceError(f"unknown command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = dispatch(args)
    except PreferenceError as exc:
        message = sanitize_text(str(exc)).text
        print(f"wikiskill-preference: {message}", file=sys.stderr)
        return 2
    except (OSError, ValueError, KeyError, TypeError) as exc:
        message = sanitize_text(str(exc)).text
        print(f"wikiskill-preference: {message}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
