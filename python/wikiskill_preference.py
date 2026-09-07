#!/usr/bin/env python3
"""CLI for the independent personal-preference group mode."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from wikiskill_preference_core.classification import (  # noqa: E402
    PROMPT_VERSION as CLASSIFICATION_PROMPT_VERSION,
    build_group_classification_prompt,
    classify_group,
)
from wikiskill_preference_core.config import PreferenceConfig  # noqa: E402
from wikiskill_preference_core.contracts import (  # noqa: E402
    GroupClassificationRequest,
    PreferenceGroup,
    new_id,
    stable_hash,
    stable_json_dumps,
    utc_now,
)
from wikiskill_preference_core.evidence import EvidenceStore  # noqa: E402
from wikiskill_preference_core.errors import (  # noqa: E402
    PreferenceConflictError,
    PreferenceContractError,
    PreferenceError,
    PreferenceGitError,
    PreferenceIntegrityError,
)
from wikiskill_preference_core.learning_contracts import (  # noqa: E402
    CommandRequest,
    error_envelope,
    success_envelope,
)
from wikiskill_preference_core.jobs import FeedbackJobs  # noqa: E402
from wikiskill_preference_core.model_client import call_openai_compatible_result  # noqa: E402
from wikiskill_preference_core.proposals import (  # noqa: E402
    ProposalStore,
    apply_rollback,
    build_group_effects,
    generated_transaction_id,
    load_operation_records,
    operation_record,
    rollback_preview,
    write_operation_path,
)
from wikiskill_preference_core.git_sync import (  # noqa: E402
    begin_generated_transaction,
    commit_generated,
    complete_generated_transaction,
    initialize_commit,
    pull_rebase,
    push,
    repository_head,
    restore_generated_transaction,
    sync_state,
)
from wikiskill_preference_core.sanitizing import sanitize_text  # noqa: E402
from wikiskill_preference_core.store import (  # noqa: E402
    PreferenceStore,
    atomic_delete,
    atomic_write_bytes,
    atomic_write_text,
)
from wikiskill_preference_core.transactions import (  # noqa: E402
    PersistentTransaction,
    data_root_lock,
    recover_transactions,
)



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


def _json_line_input() -> dict[str, Any]:
    try:
        text = sys.stdin.readline()
    except OSError as exc:
        raise PreferenceError(f"cannot read stdin: {exc}") from exc
    if not text.strip():
        raise PreferenceError("stdin must contain a JSON object line")
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PreferenceError(f"stdin line is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise PreferenceError("stdin JSON line must be an object")
    return value


def _pi_model_response(prompt: str) -> Any:
    print(json.dumps({"type": "model_request", "prompt": prompt}, ensure_ascii=False), flush=True)
    value = _json_line_input()
    if set(value) != {"model_response"}:
        raise PreferenceError("Pi model bridge response must contain only model_response")
    return value["model_response"]


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
    return {"ok": True, "groups": [group.to_dict() for group in store.read_groups_v2()]}


def _classification_request(store: PreferenceStore, value: dict[str, Any]) -> GroupClassificationRequest:
    request = GroupClassificationRequest.from_dict(value)
    request.validate_for(store.group_names())
    return request


def _classify_group(
    store: PreferenceStore,
    value: dict[str, Any],
    model_responder: Callable[[str], Any] | None = None,
) -> dict[str, Any]:
    request = _classification_request(store, value)
    diagnostics: list[str] = []
    try:
        model_response = (
            model_responder(build_group_classification_prompt(request))
            if model_responder is not None else None
        )
        result = classify_group(store.config, request, model_response=model_response, diagnostics=diagnostics)
    except PreferenceError as exc:
        store.write_last_run({
            "ok": False,
            "stage": "classification",
            "model": store.config.model_identity(),
            "prompt_version": CLASSIFICATION_PROMPT_VERSION,
            "error": sanitize_text(str(exc)).text[:500],
        })
        raise
    store.write_last_run({
        "ok": True,
        "stage": "classification",
        "group": result.group,
        "model": store.config.model_identity(),
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
    if not isinstance(group, str) or not group.strip() or not isinstance(rule, str) or not rule.strip():
        raise PreferenceError("remember group and rule must be non-empty strings")
    current = store._require_group(group)
    normalized_rule = PreferenceGroup.from_dict({"name": group, "description": current.description, "rules": [sanitize_text(rule).text]}).rules[0]
    if normalized_rule in current.rules:
        return {"ok": True, "group": group, "rule": normalized_rule, "duplicate": True, "commit": None, "pushed": False, "sync_state": sync_state(store.repo)}
    before_document = {"schema_version": 2, "groups": [item.to_dict() for item in store.read_groups_v2()]}
    transaction = begin_generated_transaction(store.repo, data_root=store.root)
    try:
        updated = store.add_group_rule(group, normalized_rule)
        after_document = {"schema_version": 2, "groups": [item.to_dict() for item in store.read_groups_v2()]}
        operation_id = new_id("operation-")
        effects = build_group_effects(before_document, after_document, source_kind="user_remember")
        record = operation_record(
            operation_id=operation_id,
            transaction_id=generated_transaction_id(transaction),
            kind="remember",
            source_kind="user_remember",
            before_groups=before_document,
            after_groups=after_document,
            effects=effects,
        )
        write_operation_path(store.root, record)
        commit = commit_generated(store.repo, "personal-preferences: remember")
        if not commit:
            raise PreferenceGitError("remember did not create a Git commit")
        complete_generated_transaction(transaction)
    except Exception:
        restore_generated_transaction(transaction)
        raise
    push_result = _push_result(store, requested=store.config.git_auto_push)
    store.append_metric({"kind": "remember", "group": group, "rules": store.rule_count()})
    ProposalStore(store.root).revalidate_all()
    return {"ok": True, "group": group, "rule": normalized_rule, "duplicate": False, "restored": False, "operation_id": operation_id, "commit": commit, **push_result, "sync_state": sync_state(store.repo)}


def _diff_line_counts(raw_diff: str) -> tuple[int, int]:
    added = sum(line.startswith("+") and not line.startswith("+++") for line in raw_diff.splitlines())
    removed = sum(line.startswith("-") and not line.startswith("---") for line in raw_diff.splitlines())
    return added, removed


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
    before_document = json.loads(before)
    deleted_group_id = store._require_group_v2(value["group"]).id if action == "delete" else None
    transaction = begin_generated_transaction(
        store.repo,
        extra_paths=(store.local_root,),
        data_root=store.root,
    )
    lifecycle: dict[str, Any] = {}
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
            if deleted_group_id is None:
                raise PreferenceError("deleted group ID was not resolved", code="integrity_error")
            evidence_result, evidence_writes = EvidenceStore(store.root).prepare_group_delete(deleted_group_id)
            jobs_result, jobs_writes = FeedbackJobs(store.root).prepare_group_delete(deleted_group_id)
            proposal_result, proposal_writes = ProposalStore(store.root).prepare_group_delete(deleted_group_id)
            for path, content in {**evidence_writes, **jobs_writes, **proposal_writes}.items():
                if content is None:
                    atomic_delete(path)
                else:
                    atomic_write_bytes(path, content)
            lifecycle = {**evidence_result, **jobs_result, **proposal_result}
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

        after_document = json.loads(store.groups_path.read_text(encoding="utf-8"))
        changed = before_document != after_document
        operation_id = None
        if changed:
            operation_id = new_id("operation-")
            effects = build_group_effects(before_document, after_document, source_kind="group_management")
            write_operation_path(store.root, operation_record(
                operation_id=operation_id,
                transaction_id=generated_transaction_id(transaction),
                kind="group_management",
                source_kind="group_management",
                before_groups=before_document,
                after_groups=after_document,
                effects=effects,
            ))
        commit = commit_generated(store.repo, f"personal-preferences: group {action}") if changed else None
        if changed and not commit:
            raise PreferenceGitError("preference group change did not create a Git commit")
        complete_generated_transaction(transaction)
    except Exception:
        restore_generated_transaction(transaction)
        raise
    proposal_stale = ProposalStore(store.root).revalidate_all() if changed else {"stale_proposal_ids": []}
    push_result = _push_result(store, requested=bool(commit and store.config.git_auto_push))
    return {
        "ok": True,
        "action": action,
        "group": result_group,
        "groups": [group.to_dict() for group in store.read_groups()],
        "changed": changed,
        "operation_id": operation_id,
        "commit": commit,
        **push_result,
        "sync_state": sync_state(store.repo),
        **lifecycle,
        **proposal_stale,
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


_SETTINGS_ROOT_FIELDS = {"enabled", "git_auto_push", "capture_user_edits", "store_raw_diffs", "provider", "learning", "privacy"}
_SETTINGS_LEARNING_FIELDS = {"extraction", "proposals", "proposal_trigger", "max_attempts", "max_requests_per_day"}
_SETTINGS_STAGE_FIELDS = {"enabled", "provider", "thinking_level", "timeout_seconds", "max_tokens"}
_SETTINGS_PRIVACY_FIELDS = {"context_mode", "snapshot_retention_days"}
_SETTINGS_UPDATE_FIELDS = {"patch", "revoke_feedback_authorization", "revoke_proposal_authorization", "clear_snapshots"}
_SETTINGS_ACTIVE_STATES = {"queued", "running", "retry_wait"}


def _settings_digest(config: PreferenceConfig) -> str:
    return f"sha256:{stable_hash(config.to_dict())}"


def _settings_state(store: PreferenceStore) -> dict[str, Any]:
    path = store.root / "local" / "settings-state.json"
    digest = _settings_digest(store.config)
    if not path.exists():
        return {"schema_version": 1, "generation": 0, "config_digest": digest}
    if path.is_symlink() or not path.is_file():
        raise PreferenceIntegrityError("settings state must be a regular file")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise PreferenceIntegrityError("settings state is unreadable") from exc
    if (not isinstance(value, dict) or set(value) != {"schema_version", "generation", "config_digest"}
            or value.get("schema_version") != 1 or type(value.get("generation")) is not int
            or value["generation"] < 0 or value.get("config_digest") != digest):
        raise PreferenceIntegrityError("settings state does not match the current normalized config")
    return value


def _settings_patch(config: PreferenceConfig, value: Any) -> PreferenceConfig:
    if not isinstance(value, dict) or not value or set(value) - _SETTINGS_ROOT_FIELDS:
        raise PreferenceContractError("settings patch has an invalid root field allowlist")
    data = config.to_dict()
    for key, item in value.items():
        if key in {"enabled", "git_auto_push", "capture_user_edits", "store_raw_diffs"}:
            if not isinstance(item, bool):
                raise PreferenceContractError(f"settings patch {key} must be boolean")
            data[key] = item
        elif key == "provider":
            if not isinstance(item, dict):
                raise PreferenceContractError("settings patch provider must be a complete object")
            data[key] = item
        elif key == "privacy":
            if not isinstance(item, dict) or not item or set(item) - _SETTINGS_PRIVACY_FIELDS:
                raise PreferenceContractError("settings patch privacy has an invalid field allowlist")
            data[key] = {**data[key], **item}
        else:
            if not isinstance(item, dict) or not item or set(item) - _SETTINGS_LEARNING_FIELDS:
                raise PreferenceContractError("settings patch learning has an invalid field allowlist")
            learning = dict(data["learning"])
            for learning_key, learning_value in item.items():
                if learning_key in {"extraction", "proposals"}:
                    if (not isinstance(learning_value, dict) or not learning_value
                            or set(learning_value) - _SETTINGS_STAGE_FIELDS):
                        raise PreferenceContractError(f"settings patch learning.{learning_key} has an invalid field allowlist")
                    learning[learning_key] = {**learning[learning_key], **learning_value}
                else:
                    learning[learning_key] = learning_value
            data[key] = learning
    return PreferenceConfig.from_dict(data, config.data_root)


def _block_jobs_for_settings(
    rows: list[dict[str, Any]],
    *,
    disabled: bool,
    revoked: bool,
    clear_snapshots: bool = False,
) -> tuple[bool, set[str]]:
    changed = False
    stopped: set[str] = set()
    for row in rows:
        state = row.get("state")
        snapshot_cleared = clear_snapshots and row.get("snapshot_ref") is not None
        if snapshot_cleared:
            row["snapshot_ref"] = None
            row["snapshot_digest"] = None
            row["state"] = "needs_review"
            row["error_code"] = "snapshot_cleared"
        elif state in _SETTINGS_ACTIVE_STATES and (disabled or revoked):
            row["state"] = "blocked_config" if disabled else "blocked_consent"
            row["error_code"] = "stage_disabled" if disabled else "authorization_revoked"
        else:
            continue
        row["generation"] += 1
        row["updated_at"] = utc_now()
        row["lease"] = None
        row["next_attempt_at"] = None
        stopped.add(str(row["job_id"]))
        changed = True
    return changed, stopped


def _settings_get(store: PreferenceStore) -> tuple[dict[str, Any], dict[str, Any]]:
    from wikiskill_preference_core.learning_contracts import cas_for
    state = _settings_state(store)
    feedback_consent = None
    proposal_consent = None
    try:
        feedback_consent = FeedbackJobs(store.root)._consent()
    except PreferenceError:
        pass
    try:
        proposal_consent = ProposalStore(store.root)._consent()
    except PreferenceError:
        pass
    data = {
        "config": store.config.to_dict(),
        "feedback_authorization": feedback_consent,
        "proposal_authorization": proposal_consent,
        "snapshot_count": len(list((store.root / "local" / "feedback-snapshots").glob("*.json"))),
    }
    return data, cas_for("settings", state["generation"], data).to_dict()


def _settings_update(store: PreferenceStore, payload: Any, expected_generation: int | None) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(payload, dict) or set(payload) != _SETTINGS_UPDATE_FIELDS:
        raise PreferenceContractError("settings update has an invalid schema")
    for key in ("revoke_feedback_authorization", "revoke_proposal_authorization", "clear_snapshots"):
        if not isinstance(payload[key], bool):
            raise PreferenceContractError(f"settings update {key} must be boolean")
    state = _settings_state(store)
    if expected_generation != state["generation"]:
        raise PreferenceConflictError("settings generation changed", code="generation_conflict", retryable=True)
    patch = payload["patch"]
    if not isinstance(patch, dict):
        raise PreferenceContractError("settings update patch must be an object")
    if not patch and not any(payload[key] for key in ("revoke_feedback_authorization", "revoke_proposal_authorization", "clear_snapshots")):
        raise PreferenceContractError("settings update requires a setting or privacy action")
    config = _settings_patch(store.config, patch) if patch else store.config
    feedback = FeedbackJobs(store.root)
    proposals = ProposalStore(store.root)
    feedback_rows = feedback._jobs()
    proposal_rows = proposals._jobs()
    feedback_disabled = not config.enabled or not config.stage_enabled("extraction")
    proposal_disabled = not config.enabled or not config.stage_enabled("proposals")
    feedback_binding_changed = config.stage_provider("extraction") != store.config.stage_provider("extraction")
    proposal_binding_changed = config.stage_provider("proposals") != store.config.stage_provider("proposals")
    revoke_feedback = payload["revoke_feedback_authorization"] or feedback_binding_changed
    revoke_proposal = payload["revoke_proposal_authorization"] or proposal_binding_changed
    feedback_changed, stopped_feedback = _block_jobs_for_settings(
        feedback_rows,
        disabled=feedback_disabled,
        revoked=revoke_feedback,
        clear_snapshots=payload["clear_snapshots"],
    )
    proposal_changed, stopped_proposals = _block_jobs_for_settings(
        proposal_rows,
        disabled=proposal_disabled,
        revoked=revoke_proposal,
    )
    writes: dict[Path, bytes | None] = {
        store.root / "config.json": (stable_json_dumps(config.to_dict()) + "\n").encode("utf-8"),
    }
    if feedback_changed:
        writes[feedback.jobs_path] = (stable_json_dumps(feedback_rows) + "\n").encode("utf-8")
        feedback_state = feedback._state()
        feedback_state["collection_revision"] += 1
        writes[feedback.state_path] = (stable_json_dumps(feedback_state) + "\n").encode("utf-8")
    if proposal_changed:
        writes[proposals.jobs_path] = (stable_json_dumps(proposal_rows) + "\n").encode("utf-8")
        proposal_state = proposals._state()
        proposal_state["collection_revision"] += 1
        writes[proposals.state_path] = (stable_json_dumps(proposal_state) + "\n").encode("utf-8")
    worker = feedback._worker()
    if isinstance(worker, dict) and worker.get("job_id") in stopped_feedback | stopped_proposals:
        writes[feedback.worker_path] = None
    if revoke_feedback:
        writes[feedback.consent_path] = None
    if revoke_proposal:
        writes[proposals.consent_path] = None
    if payload["clear_snapshots"]:
        snapshot_dir = store.root / "local" / "feedback-snapshots"
        if snapshot_dir.exists() and snapshot_dir.is_symlink():
            raise PreferenceIntegrityError("feedback snapshots cannot be a symlink")
        for path in snapshot_dir.glob("*.json"):
            if path.is_symlink() or not path.is_file():
                raise PreferenceIntegrityError("feedback snapshot must be a regular file")
            writes[path] = None
    next_state = {"schema_version": 1, "generation": state["generation"] + 1, "config_digest": _settings_digest(config)}
    writes[store.root / "local" / "settings-state.json"] = (stable_json_dumps(next_state) + "\n").encode("utf-8")
    transaction = PersistentTransaction.begin_local(store.root, writes)
    try:
        transaction.apply()
        transaction.commit_local()
    except Exception:
        transaction.rollback()
        raise
    return _settings_get(PreferenceStore(store.root))


def _settings_v2_command(args: argparse.Namespace) -> dict[str, Any]:
    raw = _json_input()
    request_id = raw.get("request_id") if isinstance(raw, dict) else None
    args.v2_request_id = request_id if isinstance(request_id, str) else "invalid-request"
    request = CommandRequest.from_dict(raw)
    args.v2_request_id = request.request_id
    store = PreferenceStore(args.data_root)
    if request.action == "get":
        if request.expected_generation is not None or request.payload:
            raise PreferenceContractError("settings get requires null generation and empty payload")
        data, cas = _settings_get(store)
    elif request.action == "update":
        data, cas = _settings_update(store, request.payload, request.expected_generation)
    else:
        raise PreferenceContractError(f"unsupported settings action: {request.action}", code="unsupported_action")
    from wikiskill_preference_core.learning_contracts import CasState
    return success_envelope(request.request_id, data, cas=CasState.from_dict(cas))


def _provider_status(config: PreferenceConfig, stage: str) -> dict[str, Any]:
    provider = config.stage_provider(stage)
    source = "pi" if provider["name"] == "pi" else "fake" if provider["name"] == "fake" else "custom"
    if provider["name"] == "pi":
        ready: bool | None = None
        message = "authorization is checked only when binding or sending"
        model = "bind-time selection"
    else:
        ready, message = config.model_readiness(provider=provider)
        model = str(provider["model"])
    return {
        "enabled": config.stage_enabled(stage),
        "provider_source": source,
        "provider_name": provider["name"],
        "provider_model": model,
        "thinking_level": provider["thinking_level"],
        "timeout_seconds": provider["timeout_seconds"],
        "max_tokens": provider["max_tokens"],
        "model_ready": ready,
        "model_status": message,
    }


def _status(store: PreferenceStore) -> dict[str, Any]:
    provider = store.config.provider
    if provider["name"] == "pi":
        model_ready = None
        model_status = "authorization is checked only when binding or sending"
        provider_name = "pi"
        provider_model = "bind-time selection"
        provider_source = "pi"
        credential_env = "Pi credential store"
        provider_thinking_level = str(provider["thinking_level"])
    else:
        model_ready, model_status = store.config.model_readiness()
        provider_name = str(provider["name"])
        provider_model = str(provider["model"])
        provider_source = "fake" if provider["name"] == "fake" else "custom"
        credential_env = str(provider["api_key_env"])
        provider_thinking_level = store.config.effective_thinking_level()
    jobs = FeedbackJobs(store.root)
    job_rows = jobs.list()[0]["jobs"]
    proposal_data = ProposalStore(store.root).inspect()[0]
    proposal_jobs = proposal_data["jobs"]
    proposal_rows = proposal_data["proposals"]
    pending_jobs = [row for row in job_rows if row["state"] in {"queued", "running", "retry_wait", "blocked_config", "blocked_model", "blocked_consent", "blocked_budget"}]
    evidence_rows = EvidenceStore(store.root).view()["evidence"]
    pending_evidence = [
        row for row in evidence_rows
        if row["status"] in {"conflict", "orphaned_group"}
        or (
            row["status"] == "active"
            and isinstance(row.get("revision"), dict)
            and isinstance(row["revision"].get("content"), dict)
            and row["revision"]["content"].get("needs_review") is True
        )
    ]
    unmaterialized_jobs = [row for row in job_rows if row["state"] == "needs_review" and row["result_ref"] is None]
    pending_withdrawal_publish = [row for row in evidence_rows if row["withdrawal_pending_publish"]]
    learning_state = jobs._state()
    today = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date().isoformat()
    used_requests = learning_state["daily_requests"] if learning_state["daily_date"] == today else 0
    usage_rows = [
        {"stage": "extraction", "job_id": row["job_id"], "usage": row["usage"]}
        for row in job_rows if row.get("usage") is not None
    ] + [
        {"stage": "proposals", "job_id": row["job_id"], "usage": row["usage"]}
        for row in proposal_jobs if row.get("usage") is not None
    ]
    return {
        "ok": True,
        "enabled": store.config.enabled,
        "groups": store.group_count(),
        "rules": store.rule_count(),
        "pending_feedback_count": len(pending_jobs),
        "pending_evidence_count": len(pending_evidence) + len(unmaterialized_jobs),
        "pending_evidence_withdrawal_publish_count": len(pending_withdrawal_publish),
        "pending_proposal_job_count": len([row for row in proposal_jobs if row["state"] in {"queued", "running", "retry_wait", "blocked_config", "blocked_model", "blocked_consent", "blocked_budget"}]),
        "pending_proposal_count": len([row for row in proposal_rows if row["state"] in {"pending_review", "deferred", "blocked", "stale"}]),
        "learning_stages": {
            "extraction": _provider_status(store.config, "extraction"),
            "proposals": _provider_status(store.config, "proposals"),
        },
        "proposal_trigger": store.config.learning["proposal_trigger"],
        "daily_requests_used": used_requests,
        "daily_requests_limit": store.config.learning["max_requests_per_day"],
        "usage": usage_rows[-100:],
        "model_ready": model_ready,
        "model_status": model_status,
        "provider_source": provider_source,
        "provider_name": provider_name,
        "provider_model": provider_model,
        "provider_thinking_level": provider_thinking_level,
        "provider_timeout_seconds": float(provider.get("timeout_seconds", 60)),
        "provider_base_url_ready": model_ready,
        "provider_credential_env": credential_env,
        "provider_credential_ready": model_ready,
        "sync_state": sync_state(store.repo),
    }


def _sync(store: PreferenceStore) -> dict[str, Any]:
    EvidenceStore(store.root).view()
    load_operation_records(store.root)

    def validate_synced_state() -> None:
        EvidenceStore(store.root).view()
        load_operation_records(store.root)

    pulled = pull_rebase(
        store.repo,
        data_root=store.root,
        validate=validate_synced_state,
    )
    EvidenceStore(store.root).view()
    stale = ProposalStore(store.root).revalidate_all()
    push_result = _push_result(store, requested=True)
    return {
        "ok": True,
        "groups": [group.to_dict() for group in store.read_groups_v2()],
        "pulled": pulled,
        **push_result,
        "git_head": repository_head(store.repo),
        "sync_state": sync_state(store.repo),
        **stale,
    }


def _model_call(store: PreferenceStore, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(payload, dict) or set(payload) != {"prompt", "model_selection", "authorization"}:
        raise PreferenceError("model-call requires prompt, model_selection, and authorization", code="invalid_request")
    prompt = payload["prompt"]
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 128 * 1024:
        raise PreferenceError("model-call prompt is invalid", code="invalid_request")
    selection = payload["model_selection"]
    if not isinstance(selection, dict) or not isinstance(payload["authorization"], dict):
        raise PreferenceError("model-call model selection or authorization is invalid", code="invalid_request")
    from wikiskill_preference_core.jobs import _selection
    selection = _selection(selection)
    authorization = dict(payload["authorization"])
    if authorization.get("model_selection") != selection:
        raise PreferenceError("model-call authorization does not match the selected model", code="invalid_request")
    # Validate the exact active lease, operation-specific consent, config, and
    # actual endpoint while briefly holding the data-root lock, then release it
    # before network I/O. Feedback consent never authorizes proposal evidence.
    with data_root_lock(store.root):
        recover_transactions(store.root)
        if str(authorization.get("job_id", "")).startswith("proposal-job-"):
            authorized, _ = ProposalStore(store.root).authorize_send(authorization)
        else:
            authorized, _ = FeedbackJobs(store.root).authorize_send(authorization)
    if authorized.get("blocked"):
        job = authorized.get("job") if isinstance(authorized.get("job"), dict) else {}
        raise PreferenceError("model-call authorization is blocked", code=str(job.get("error_code") or "model_unavailable"))
    current_store = PreferenceStore(store.root)
    stage = "proposals" if str(authorization.get("job_id", "")).startswith("proposal-job-") else "extraction"
    configured = current_store.config.stage_provider(stage)
    expected_source = "fake" if configured["name"] == "fake" else "custom" if configured["name"] == "openai_compatible" else "pi"
    if selection["provider_source"] != expected_source or selection["provider_id"] != (configured["name"] if expected_source != "pi" else selection["provider_id"]):
        raise PreferenceError("model-call selection does not match the configured provider", code="model_unavailable")
    if configured["name"] == "fake":
        if selection["model_id"] != configured["model"]:
            raise PreferenceError("model-call selection does not match the fake model", code="model_unavailable")
        output = os.environ.get("PREFERENCE_MODEL_RESPONSE")
        if output is None:
            raise PreferenceError("fake model response is not configured", code="model_unavailable")
        usage = {
            "known": False,
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "cost_usd": None,
            "cost_status": "unknown",
            "provider_id": selection["provider_id"],
            "model_id": selection["model_id"],
            "max_tokens": selection["max_tokens"],
        }
    elif configured["name"] == "openai_compatible":
        base_url = configured.get("base_url") or os.environ.get("OPENAI_BASE_URL") or ""
        if selection["model_id"] != configured["model"] or selection["endpoint_fingerprint"] != f"sha256:{__import__('hashlib').sha256(str(base_url).encode()).hexdigest()}":
            raise PreferenceError("model-call selection does not match the configured endpoint", code="model_unavailable")
        output, usage = call_openai_compatible_result(current_store.config, prompt, selection, provider_override=configured)
    else:
        raise PreferenceError("Pi model calls must be performed by the extension registry", code="model_unavailable")
    if not isinstance(output, str) or not output.strip():
        raise PreferenceError("model-call returned an empty response", code="model_failed")
    from wikiskill_preference_core.learning_contracts import cas_for
    return {"output": output, "usage": usage}, cas_for("model-call", 0, {"model": configured["name"]}).to_dict()


def _evidence_v2_command(args: argparse.Namespace) -> dict[str, Any]:
    raw = _json_input()
    request_id = raw.get("request_id")
    args.v2_request_id = request_id if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", request_id) else "invalid-request"
    request = CommandRequest.from_dict(raw)
    args.v2_request_id = request.request_id
    store = EvidenceStore(args.data_root)
    if request.action == "list":
        if request.expected_generation is not None or request.payload:
            raise PreferenceError("evidence list requires null generation and empty payload", code="invalid_request")
        data, cas = store.list()
    elif request.action in {"get", "impact"}:
        if request.expected_generation is not None or set(request.payload) != {"evidence_id"}:
            raise PreferenceError(f"evidence {request.action} requires evidence_id and null generation", code="invalid_request")
        handler = store.get if request.action == "get" else store.impact
        data, cas = handler(request.payload["evidence_id"])
    elif request.action == "revise":
        data, cas = store.revise(request.request_id, request.payload, request.expected_generation)
    elif request.action == "withdraw":
        data, cas = store.withdraw(request.request_id, request.payload, request.expected_generation)
    elif request.action == "restore":
        data, cas = store.restore(request.request_id, request.payload, request.expected_generation)
    elif request.action == "delete-local":
        data, cas = store.delete_local(request.request_id, request.payload, request.expected_generation)
    elif request.action == "publish":
        payload = dict(request.payload)
        mode = payload.pop("mode", None)
        if mode == "preview":
            data, cas = store.preview_publish(payload, request.expected_generation)
        elif mode == "apply":
            data, cas = store.publish(request.request_id, payload, request.expected_generation)
        else:
            raise PreferenceError("evidence publish mode must be preview or apply", code="invalid_request")
    else:
        raise PreferenceError(f"unsupported evidence action: {request.action}", code="unsupported_action")
    from wikiskill_preference_core.learning_contracts import CasState
    return success_envelope(request.request_id, data, cas=CasState.from_dict(cas))


def _proposal_v2_command(args: argparse.Namespace) -> dict[str, Any]:
    raw = _json_input()
    request_id = raw.get("request_id")
    args.v2_request_id = request_id if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", request_id) else "invalid-request"
    request = CommandRequest.from_dict(raw)
    args.v2_request_id = request.request_id
    store = PreferenceStore(args.data_root)
    proposals = ProposalStore(store.root)
    if args.command == "proposal":
        read_actions = {"preview", "list", "get"}
        write_actions = {"authorize", "generate", "trigger", "accept", "reject", "defer", "resume", "confirm-delete-opposition", "revalidate", "cancel"}
        if request.action not in read_actions | write_actions:
            raise PreferenceError(f"unsupported proposal action: {request.action}", code="unsupported_action")
        if request.action in read_actions:
            if request.expected_generation is not None:
                raise PreferenceError(f"proposal {request.action} requires null generation", code="invalid_request")
            if request.action == "preview": data, cas = proposals.preview(request.payload)
            elif request.action == "list":
                if request.payload: raise PreferenceError("proposal list requires empty payload", code="invalid_request")
                data, cas = proposals.list()
            else: data, cas = proposals.get(request.payload)
        else:
            current = proposals._state()["collection_revision"]
            if request.expected_generation != current:
                raise PreferenceError("proposal collection generation conflict", code="generation_conflict", retryable=True)
            if request.action == "authorize": data, cas = proposals.authorize(request.payload)
            elif request.action == "generate": data, cas = proposals.generate(request.request_id, request.payload)
            elif request.action == "trigger": data, cas = proposals.trigger(request.request_id, request.payload)
            elif request.action == "accept": data, cas = proposals.accept(request.request_id, request.payload)
            elif request.action == "reject": data, cas = proposals.reject(request.request_id, request.payload)
            elif request.action == "defer": data, cas = proposals.defer(request.request_id, request.payload)
            elif request.action == "resume": data, cas = proposals.resume(request.request_id, request.payload)
            elif request.action == "confirm-delete-opposition": data, cas = proposals.confirm_delete_opposition(request.request_id, request.payload)
            elif request.action == "revalidate": data, cas = proposals.revalidate(request.payload)
            else: data, cas = proposals.cancel(request.payload)
            if request.action in {"accept", "reject"} and data.get("commit"):
                data = {**data, **_push_result(store, requested=store.config.git_auto_push), "sync_state": sync_state(store.repo)}
    else:
        allowed = {"list", "sweep", "claim", "reject", "authorize-send", "renew", "complete", "cancel", "fail"}
        if request.action not in allowed:
            raise PreferenceError(f"unsupported proposal-job action: {request.action}", code="unsupported_action")
        if request.action == "list":
            if request.expected_generation is not None or request.payload:
                raise PreferenceError("proposal-job list requires null generation and empty payload", code="invalid_request")
            data, cas = proposals.job_list()
        else:
            current = proposals._state()["collection_revision"]
            if request.expected_generation != current:
                raise PreferenceError("proposal collection generation conflict", code="generation_conflict", retryable=True)
            handlers = {"sweep": lambda _payload: proposals.sweep(), "claim": proposals.claim, "reject": proposals.reject_dispatch, "authorize-send": proposals.authorize_send, "renew": proposals.renew, "complete": proposals.complete, "cancel": proposals.cancel_lease, "fail": proposals.fail}
            data, cas = handlers[request.action](request.payload)
    from wikiskill_preference_core.learning_contracts import CasState
    return success_envelope(request.request_id, data, cas=CasState.from_dict(cas))


def _history_v2_command(args: argparse.Namespace) -> dict[str, Any]:
    raw = _json_input()
    request = CommandRequest.from_dict(raw)
    args.v2_request_id = request.request_id
    if request.expected_generation is not None:
        raise PreferenceError("history reads require null generation", code="invalid_request")
    operations = load_operation_records(args.data_root)
    if request.action == "list":
        if request.payload: raise PreferenceError("history list requires empty payload", code="invalid_request")
        data = {"operations": operations}
    elif request.action == "rule":
        if set(request.payload) != {"rule_id"}: raise PreferenceError("history rule requires rule_id", code="invalid_request")
        rule_id = request.payload["rule_id"]
        if not isinstance(rule_id, str): raise PreferenceError("history rule_id is invalid", code="invalid_request")
        data = {"rule_id": rule_id, "operations": [item for item in operations if any(effect.get("rule_id") == rule_id for effect in item["effects"])]}
    else:
        raise PreferenceError(f"unsupported history action: {request.action}", code="unsupported_action")
    from wikiskill_preference_core.learning_contracts import cas_for
    return success_envelope(request.request_id, data, cas=cas_for("history", len(operations), operations))


def _learning_v2_command(args: argparse.Namespace) -> dict[str, Any]:
    raw = _json_input()
    request_id = raw.get("request_id")
    args.v2_request_id = request_id if isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", request_id) else "invalid-request"
    request = CommandRequest.from_dict(raw)
    args.v2_request_id = request.request_id
    store = PreferenceStore(args.data_root)
    jobs = FeedbackJobs(store.root)
    allowed_actions = {
        "feedback": {"preview", "authorize", "create", "create-user-edit", "list", "get", "update", "update-user-edit", "bind", "delete", "retry", "cancel"},
        "learning-job": {"sweep", "claim", "reject", "authorize-send", "renew", "complete", "cancel", "fail"},
        "model-call": {"complete"},
    }[args.command]
    if request.action not in allowed_actions:
        raise PreferenceError(f"unsupported {args.command} action: {request.action}", code="unsupported_action")
    current = jobs.list()[1]
    if request.action == "list":
        if args.command != "feedback":
            raise PreferenceError("list is available only for feedback", code="unsupported_action")
        if request.expected_generation is not None or request.payload:
            raise PreferenceError("feedback list requires null generation and empty payload", code="invalid_request")
        from wikiskill_preference_core.learning_contracts import CasState
        return success_envelope(request.request_id, jobs.list()[0], cas=CasState.from_dict(current))
    if request.action in {"get", "preview"}:
        if args.command != "feedback":
            raise PreferenceError(f"{request.action} is available only for feedback", code="unsupported_action")
        if request.expected_generation is not None:
            raise PreferenceError(f"feedback {request.action} requires null generation", code="invalid_request")
        data, cas = jobs.get(request.payload) if request.action == "get" else jobs.preview(request.payload)
        from wikiskill_preference_core.learning_contracts import CasState
        return success_envelope(request.request_id, data, cas=CasState.from_dict(cas))
    if args.command == "model-call":
        if request.action != "complete" or request.expected_generation is not None:
            raise PreferenceError("model-call requires action=complete and null generation", code="invalid_request")
        data, cas = _model_call(store, request.payload)
        from wikiskill_preference_core.learning_contracts import CasState
        return success_envelope(request.request_id, data, cas=CasState.from_dict(cas))
    if request.expected_generation != current["generation"]:
        raise PreferenceError("feedback job collection generation conflict", code="generation_conflict", retryable=True)
    if args.command == "feedback":
        handlers = {"authorize": jobs.authorize, "create": jobs.create, "create-user-edit": jobs.create_user_edit, "update": jobs.edit, "update-user-edit": jobs.update_user_edit, "bind": jobs.bind, "delete": jobs.delete, "cancel": jobs.cancel, "retry": jobs.retry}
    elif args.command == "learning-job":
        handlers = {"sweep": lambda _payload: jobs.sweep(), "claim": jobs.claim, "reject": jobs.reject_dispatch, "authorize-send": jobs.authorize_send, "renew": jobs.renew, "complete": jobs.complete, "cancel": jobs.cancel_lease, "fail": jobs.fail}
    else:
        handlers = {"complete": lambda payload: _model_call(store, payload)}
    handler = handlers.get(request.action)
    if handler is None:
        raise PreferenceError(f"unsupported {args.command} action: {request.action}", code="unsupported_action")
    data, cas = handler(request.request_id, request.payload) if request.action in {"create", "create-user-edit"} else handler(request.payload)
    from wikiskill_preference_core.learning_contracts import CasState
    return success_envelope(request.request_id, data, cas=CasState.from_dict(cas))


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

    remember = commands.add_parser("remember", help="write a rule to an existing group through stdin")
    data_root(remember)
    remember.add_argument("--stdin", action="store_true", required=True)

    classify = commands.add_parser("classify-group", help="classify a preference into an existing group through stdin")
    data_root(classify)
    classify.add_argument("--stdin", action="store_true", required=True)
    classify.add_argument("--pi-model", action="store_true", help=argparse.SUPPRESS)

    status = commands.add_parser("status", help="show personal preference group status")
    data_root(status)
    status.add_argument("--json", action="store_true", dest="json_output")

    settings = commands.add_parser("settings", help="update allowed preference settings through stdin")
    data_root(settings)
    settings.add_argument("--stdin", action="store_true", required=True)

    sync = commands.add_parser("sync", help="commit evidence and synchronize the private preference repository")
    data_root(sync)

    rollback = commands.add_parser("rollback", help="preview or confirm rollback of the latest preference operation")
    data_root(rollback)
    rollback.add_argument("--preview", action="store_true")
    rollback.add_argument("--stdin", action="store_true")

    for name, help_text in (
        ("feedback", "create, inspect, edit, delete, cancel, or retry a local feedback job"),
        ("learning-job", "claim, renew, complete, or fail a local feedback job"),
        ("model-call", "perform a pure configured model call without changing preference data"),
        ("evidence", "list, inspect, revise, withdraw, restore, delete, impact-check, or publish evidence"),
        ("proposal", "preview, authorize, generate, inspect, review, or revalidate rule proposals"),
        ("proposal-job", "claim, renew, complete, cancel, or fail a proposal job"),
        ("history", "inspect rule and operation provenance"),
    ):
        parser = commands.add_parser(name, help=help_text)
        data_root(parser)
        parser.add_argument("--stdin", action="store_true", required=True)
    return root


def dispatch(args: argparse.Namespace) -> dict[str, Any]:
    if args.command == "settings":
        if not getattr(args, "data_root_locked", False):
            with data_root_lock(args.data_root):
                recover_transactions(args.data_root)
                args.data_root_locked = True
                try:
                    return dispatch(args)
                finally:
                    args.data_root_locked = False
        return _settings_v2_command(args)
    if args.command in {"proposal", "proposal-job"}:
        if not getattr(args, "data_root_locked", False):
            with data_root_lock(args.data_root):
                recover_transactions(args.data_root)
                args.data_root_locked = True
                try:
                    return dispatch(args)
                finally:
                    args.data_root_locked = False
        return _proposal_v2_command(args)
    if args.command == "history":
        if not getattr(args, "data_root_locked", False):
            with data_root_lock(args.data_root):
                recover_transactions(args.data_root)
                args.data_root_locked = True
                try:
                    return dispatch(args)
                finally:
                    args.data_root_locked = False
        return _history_v2_command(args)
    if args.command == "evidence":
        if not getattr(args, "data_root_locked", False):
            with data_root_lock(args.data_root):
                recover_transactions(args.data_root)
                args.data_root_locked = True
                try:
                    return dispatch(args)
                finally:
                    args.data_root_locked = False
        return _evidence_v2_command(args)
    if args.command == "model-call":
        return _learning_v2_command(args)
    if args.command in {"feedback", "learning-job"}:
        if not getattr(args, "data_root_locked", False):
            with data_root_lock(args.data_root):
                recover_transactions(args.data_root)
                args.data_root_locked = True
                try:
                    return dispatch(args)
                finally:
                    args.data_root_locked = False
        return _learning_v2_command(args)
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
    write_commands = {
        "manage-group", "set-activation", "remember", "settings", "sync", "rollback",
        "feedback", "learning-job", "proposal", "proposal-job",
    }
    if args.command in write_commands and not getattr(args, "data_root_locked", False):
        with data_root_lock(args.data_root):
            recover_transactions(args.data_root)
            args.data_root_locked = True
            try:
                return dispatch(args)
            finally:
                args.data_root_locked = False
    store = PreferenceStore(args.data_root)
    if args.command == "groups":
        return _groups_output(store)
    if args.command == "manage-group":
        return _manage_group(store, _json_input())
    if args.command == "set-activation":
        return _set_activation(store, _json_input())
    if args.command == "context":
        return _context(store, _json_input())
    if args.command == "remember":
        return _remember(store, _json_input())
    if args.command == "classify-group":
        if args.pi_model and store.config.provider["name"] != "pi":
            raise PreferenceError("--pi-model requires provider.name=pi")
        reader = _json_line_input if args.pi_model else _json_input
        return _classify_group(store, reader(), _pi_model_response if args.pi_model else None)
    if args.command == "status":
        return _status(store)
    if args.command == "sync":
        return _sync(store)
    if args.command == "rollback":
        if args.preview:
            if args.stdin:
                raise PreferenceError("rollback preview does not accept stdin")
            return {"ok": True, **rollback_preview(store.root)}
        if not args.stdin:
            raise PreferenceError("rollback confirmation requires --stdin with expected operation and HEAD")
        result = apply_rollback(store.root, _json_input())
        push_result = _push_result(store, requested=store.config.git_auto_push)
        return {"ok": True, **result, **push_result, "sync_state": sync_state(store.repo)}
    raise PreferenceError(f"unknown command: {args.command}")


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = dispatch(args)
    except PreferenceError as exc:
        message = sanitize_text(str(exc)).text[:500]
        if args.command in {"feedback", "learning-job", "model-call", "evidence", "proposal", "proposal-job", "history", "settings"}:
            request_id = getattr(args, "v2_request_id", "invalid-request")
            print(json.dumps(error_envelope(
                request_id,
                code=exc.code,
                message=message,
                retryable=exc.retryable,
            ), ensure_ascii=False, sort_keys=True))
        else:
            print(f"wikiskill-preference: {message}", file=sys.stderr)
        return 2
    except (OSError, ValueError, KeyError, TypeError) as exc:
        message = sanitize_text(str(exc)).text[:500]
        if args.command in {"feedback", "learning-job", "model-call", "evidence", "proposal", "proposal-job", "history", "settings"}:
            request_id = getattr(args, "v2_request_id", "invalid-request")
            print(json.dumps(error_envelope(
                request_id,
                code="internal_error",
                message=message or "internal error",
            ), ensure_ascii=False, sort_keys=True))
        else:
            print(f"wikiskill-preference: {message}", file=sys.stderr)
        return 2
    except Exception as exc:
        if args.command not in {"feedback", "learning-job", "model-call", "evidence", "proposal", "proposal-job", "history", "settings"}:
            raise
        request_id = getattr(args, "v2_request_id", "invalid-request")
        message = sanitize_text(str(exc)).text[:500] or "internal error"
        print(json.dumps(error_envelope(
            request_id,
            code="internal_error",
            message=message,
        ), ensure_ascii=False, sort_keys=True))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
