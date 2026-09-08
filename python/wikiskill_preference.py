#!/usr/bin/env python3
"""CLI backend for Pi personal preferences.

The extension owns interaction and exactly two possible model calls. This CLI
owns validated local persistence, short locking, formal group/rule data, and
Git commits. It never reads Pi session files or credentials.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from wikiskill_preference_core.errors import (  # noqa: E402
    PreferenceError,
    PreferenceGitError,
    PreferenceValidationError,
)
from wikiskill_preference_core.git_sync import (  # noqa: E402
    assert_sync_scope,
    commit_groups,
    fetch_remote,
    push_remote,
    rebase_fetched,
    require_clean,
    restore_failed_group_write,
    sync_state,
)
from wikiskill_preference_core.storage import (  # noqa: E402
    PreferenceStore,
    checked_id,
    checked_text,
    digest,
    new_id,
    stable_json,
    utc_now,
    validate_evidence,
    validate_extraction,
    validate_model,
    validate_proposed_rules,
    validate_turn,
)

MAX_STDIN_BYTES = 32 * 1024 * 1024
MAX_SELECTED_SNAPSHOT_BYTES = 4 * 1024 * 1024


def _stdin_object(args: argparse.Namespace) -> dict[str, Any]:
    if not args.stdin:
        raise PreferenceValidationError("command requires --stdin")
    try:
        payload = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
    except OSError as exc:
        raise PreferenceValidationError(f"cannot read stdin: {exc}") from exc
    if len(payload) > MAX_STDIN_BYTES:
        raise PreferenceValidationError("stdin exceeds 32 MiB")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreferenceValidationError(f"stdin is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise PreferenceValidationError("stdin JSON must be an object")
    return value


def _strict(value: Any, required: set[str], allowed: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PreferenceValidationError(f"{label} must be an object")
    missing = required - set(value)
    unknown = set(value) - allowed
    if missing:
        raise PreferenceValidationError(f"{label} missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceValidationError(f"{label} unknown keys: {sorted(unknown)}")
    return dict(value)


def _legacy_groups(document: dict[str, Any]) -> list[dict[str, Any]]:
    return [{
        "id": group["id"],
        "revision": group["revision"],
        "name": group["name"],
        "description": group["description"],
        "rules": [rule for rule in group["rules"] if rule["enabled"]],
    } for group in document["groups"]]


def _mutate_groups(
    store: PreferenceStore,
    message: str,
    mutate: Callable[[dict[str, Any]], tuple[dict[str, Any], dict[str, Any]]],
) -> dict[str, Any]:
    with store.locked():
        repo = require_clean(store.repo)
        before_bytes = store.groups_path.read_bytes() if store.groups_path.exists() else None
        document = store.groups()
        updated, result = mutate(document)
        if updated == document:
            return {**result, "changed": False, "commit": None, "sync_state": sync_state(repo)}
        try:
            store.write_groups(updated)
            commit = commit_groups(repo, message)
            if not commit:
                raise PreferenceGitError("group update did not create a Git commit")
        except Exception:
            restore_failed_group_write(repo, before_bytes)
            raise
        return {**result, "changed": True, "commit": commit, "sync_state": sync_state(repo)}


def _status(store: PreferenceStore) -> dict[str, Any]:
    groups = store.groups()
    learning = store.learning()
    pending = _pending_list(store)
    return {
        "ok": True,
        "enabled": store.enabled(),
        "groups": len(groups["groups"]),
        "rules": sum(len([rule for rule in group["rules"] if rule["enabled"]]) for group in groups["groups"]),
        "saved_feedback_count": len(learning["feedback"]),
        "pending_feedback_count": len(pending["feedback"]),
        "pending_proposal_count": len(pending["proposals"]),
        "pending_evolution_count": len(pending["evolution_groups"]),
        "actionable_count": len(pending["feedback"]) + len(pending["proposals"]) + len(pending["evolution_groups"]),
        "sync_state": sync_state(store.repo),
    }


def _context(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"directory", "session_id"}, {"directory", "session_id"}, "context")
    directory = checked_text(data["directory"], "directory", maximum=4096)
    session_id = checked_text(data["session_id"], "session_id", maximum=256)
    groups = store.groups()["groups"]
    by_id = {item["id"]: item["name"] for item in groups}
    activations = store.activations()
    directory_ids = [item for item in activations["directories"].get(directory, []) if item in by_id]
    session_ids = [item for item in activations["sessions"].get(session_id, []) if item in by_id]
    effective = (["global"] if "global" in {item["name"] for item in groups} else []) + [
        by_id[item] for item in [*directory_ids, *session_ids] if by_id[item] != "global"
    ]
    return {
        "ok": True,
        "effective_groups": list(dict.fromkeys(effective)),
        "directory_groups": [by_id[item] for item in directory_ids],
        "session_groups": [by_id[item] for item in session_ids],
    }


def _remember(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"group", "rule"}, {"group", "rule"}, "remember")
    group_name = checked_text(data["group"], "group", maximum=128)
    rule_text = checked_text(data["rule"], "rule", maximum=1000)

    def mutate(document: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        group = store.group_by_name(group_name, document)
        if rule_text in store.active_rule_texts(group):
            return document, {"ok": True, "group": group_name, "rule": rule_text, "duplicate": True}
        replacement = {
            **group,
            "revision": group["revision"] + 1,
            "rules": [*group["rules"], {"id": new_id("rule-"), "revision": 1, "text": rule_text, "enabled": True}],
        }
        return store.replace_group(document, replacement), {"ok": True, "group": group_name, "rule": rule_text, "duplicate": False}

    return _mutate_groups(store, "personal-preferences: remember", mutate)


def _manage_group(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    action = checked_text(value.get("action"), "action", maximum=64)
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
        raise PreferenceValidationError(f"unsupported group action: {action}")
    data = _strict(value, *specs[action], f"manage-group {action}")

    def mutate(document: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        groups = list(document["groups"])
        if action == "create":
            name = checked_text(data["name"], "group.name", maximum=128)
            description = checked_text(data["description"], "group.description", maximum=2000)
            if any(item["name"] == name for item in groups):
                raise PreferenceValidationError(f"preference group already exists: {name}")
            groups.append({"id": new_id("grp-"), "revision": 1, "name": name, "description": description, "rules": []})
            return {"schema_version": 2, "groups": groups}, {"ok": True, "group": name}

        group_name = checked_text(data.get("group", data.get("source_group")), "group", maximum=128)
        group = store.group_by_name(group_name, document)
        if action == "delete":
            if group_name == "global":
                raise PreferenceValidationError("the global preference group cannot be deleted")
            return {"schema_version": 2, "groups": [item for item in groups if item["id"] != group["id"]]}, {"ok": True, "group": group_name}
        if action == "update_description":
            replacement = {**group, "revision": group["revision"] + 1, "description": checked_text(data["description"], "description", maximum=2000)}
        elif action == "add_rule":
            rule = checked_text(data["rule"], "rule", maximum=1000)
            if rule in store.active_rule_texts(group):
                raise PreferenceValidationError("rule already exists")
            replacement = {**group, "revision": group["revision"] + 1, "rules": [*group["rules"], {"id": new_id("rule-"), "revision": 1, "text": rule, "enabled": True}]}
        elif action in {"update_rule", "delete_rule"}:
            rule = checked_text(data["rule"], "rule", maximum=1000)
            current = next((item for item in group["rules"] if item["text"] == rule and item["enabled"]), None)
            if current is None:
                raise PreferenceValidationError("rule does not exist")
            if action == "delete_rule":
                rules = [item for item in group["rules"] if item["id"] != current["id"]]
            else:
                replacement_text = checked_text(data["replacement"], "replacement", maximum=1000)
                if replacement_text != rule and replacement_text in store.active_rule_texts(group):
                    raise PreferenceValidationError("replacement rule already exists")
                rules = [{**item, "revision": item["revision"] + 1, "text": replacement_text} if item["id"] == current["id"] else item for item in group["rules"]]
            replacement = {**group, "revision": group["revision"] + 1, "rules": rules}
        else:
            target_name = checked_text(data["target_group"], "target_group", maximum=128)
            target = store.group_by_name(target_name, document)
            if target["id"] == group["id"]:
                raise PreferenceValidationError("source and target groups must differ")
            rule = checked_text(data["rule"], "rule", maximum=1000)
            current = next((item for item in group["rules"] if item["text"] == rule and item["enabled"]), None)
            if current is None:
                raise PreferenceValidationError("rule does not exist")
            if rule in store.active_rule_texts(target):
                raise PreferenceValidationError("target group already has the rule")
            source_replacement = {**group, "revision": group["revision"] + 1, "rules": [item for item in group["rules"] if item["id"] != current["id"]]}
            target_replacement = {**target, "revision": target["revision"] + 1, "rules": [*target["rules"], current]}
            updated = {"schema_version": 2, "groups": [source_replacement if item["id"] == group["id"] else target_replacement if item["id"] == target["id"] else item for item in groups]}
            return updated, {"ok": True, "group": target_name}
        return store.replace_group(document, replacement), {"ok": True, "group": group_name}

    return _mutate_groups(store, f"personal-preferences: group {action}", mutate)


def _set_activation(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"target", "key", "group", "enabled"}, {"target", "key", "group", "enabled"}, "set-activation")
    target = data["target"]
    if target not in {"directory", "session"}:
        raise PreferenceValidationError("activation target must be directory or session")
    key = checked_text(data["key"], "activation key", maximum=4096)
    group_name = checked_text(data["group"], "group", maximum=128)
    if not isinstance(data["enabled"], bool):
        raise PreferenceValidationError("activation enabled must be boolean")
    with store.locked():
        group = store.group_by_name(group_name)
        if group_name == "global":
            raise PreferenceValidationError("global is always enabled")
        document = store.activations()
        collection = document["directories" if target == "directory" else "sessions"]
        valid_ids = {item["id"] for item in store.groups()["groups"]}
        values = [item for item in collection.get(key, []) if item in valid_ids]
        if data["enabled"] and group["id"] not in values:
            values.append(group["id"])
        if not data["enabled"]:
            values = [item for item in values if item != group["id"]]
        if values:
            collection[key] = values
        else:
            collection.pop(key, None)
        store.write_activations(document)
    return {"ok": True, "target": target, "group": group_name, "enabled": data["enabled"]}


def _feedback_create(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"sentiment", "reason", "selected_turns", "model", "group"}, {"sentiment", "reason", "selected_turns", "model", "group"}, "feedback-create")
    if data["sentiment"] not in {"good", "fix"}:
        raise PreferenceValidationError("sentiment must be good or fix")
    reason = checked_text(data["reason"], "reason", maximum=4000)
    if not isinstance(data["selected_turns"], list) or not 1 <= len(data["selected_turns"]) <= 10:
        raise PreferenceValidationError("selected_turns must contain 1..10 turns")
    turns = [validate_turn(item, index) for index, item in enumerate(data["selected_turns"])]
    if len(stable_json(turns).encode("utf-8")) > MAX_SELECTED_SNAPSHOT_BYTES:
        raise PreferenceValidationError("selected_turns snapshot exceeds 4 MiB")
    model = None if data["model"] is None else validate_model(data["model"])
    group_name = None
    if data["group"] is not None:
        group_name = store.group_by_name(checked_text(data["group"], "group", maximum=128))["name"]
    feedback = {
        "id": new_id("feedback-"),
        "created_at": utc_now(),
        "sentiment": data["sentiment"],
        "reason": reason,
        "selected_turns": turns,
        "model": model,
        "group_name": group_name,
        "status": "saved",
        "evidence_id": None,
        "error": None,
        "extraction": None,
    }
    with store.locked():
        learning = store.learning()
        learning["feedback"].append(feedback)
        store.write_learning(learning)
    return {"ok": True, "feedback": feedback}


def _quote_sources(feedback: dict[str, Any], evidence: dict[str, Any] | None) -> list[dict[str, str]]:
    if evidence is None:
        return []
    result = []
    for quote in evidence["supporting_quotes"]:
        in_user = False
        in_assistant = False
        in_tool = False
        for turn in feedback["selected_turns"]:
            if "events" in turn:
                in_user = in_user or any(event["type"] == "user" and quote in event["text"] for event in turn["events"])
                in_assistant = in_assistant or any(event["type"] == "assistant" and quote in event["text"] for event in turn["events"])
                in_tool = in_tool or any(event["type"] == "file_change_result" and quote in event["content"] for event in turn["events"])
            else:
                in_user = in_user or quote in turn["user"]
                in_assistant = in_assistant or quote in turn["assistant"]
                in_tool = in_tool or any(quote in change["content"] for change in turn.get("file_changes", []))
        role = "both" if in_user and in_assistant else "user" if in_user else "assistant" if in_assistant else "tool" if in_tool else "unknown"
        result.append({"text": quote, "role": role})
    return result


def _validated_extraction(store: PreferenceStore, feedback: dict[str, Any], value: Any) -> dict[str, Any]:
    extraction = validate_extraction(value)
    for source in _quote_sources(feedback, extraction["evidence"]):
        if source["role"] == "unknown":
            raise PreferenceValidationError("extraction supporting_quotes must each come from one selected user/assistant event or successful file change result")
    return extraction


def _extraction_group(store: PreferenceStore, feedback: dict[str, Any]) -> str | None:
    names = {item["name"] for item in store.groups()["groups"]}
    explicit = feedback.get("group_name")
    if explicit is not None:
        return explicit if explicit in names else None
    extraction = feedback.get("extraction")
    if extraction and extraction["group"]["certain"] and extraction["group"]["name"] in names:
        return extraction["group"]["name"]
    return None


def _feedback_extracted(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"feedback_id", "extraction", "model"}, {"feedback_id", "extraction", "model"}, "feedback-extracted")
    model = validate_model(data["model"])
    with store.locked():
        learning = store.learning()
        feedback = store.require_feedback(learning, data["feedback_id"])
        if feedback["status"] != "organized":
            changed = False
            if feedback.get("extraction") is None:
                feedback["extraction"] = _validated_extraction(store, feedback, data["extraction"])
                feedback["model"] = model
                changed = True
            next_status = "saved" if _extraction_group(store, feedback) is not None else "pending_group"
            if feedback["status"] != next_status or feedback["error"] is not None:
                feedback["status"] = next_status
                feedback["error"] = None
                changed = True
            if changed:
                store.write_learning(learning)
        return {
            "ok": True,
            "feedback": feedback,
            "needs_group": feedback["status"] != "organized" and _extraction_group(store, feedback) is None,
        }


def _feedback_fail(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"feedback_id"}, {"feedback_id", "error"}, "feedback-fail")
    error = checked_text(data.get("error", "模型整理失败"), "feedback.error", maximum=500)
    with store.locked():
        learning = store.learning()
        feedback = store.require_feedback(learning, data["feedback_id"])
        if feedback["status"] != "organized":
            feedback["status"] = "failed"
            feedback["error"] = error
            store.write_learning(learning)
    return {"ok": True, "feedback": feedback}


def _feedback_complete(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"feedback_id", "group"}, {"feedback_id", "group"}, "feedback-complete")
    group_name = checked_text(data["group"], "group", maximum=128)
    with store.locked():
        learning = store.learning()
        feedback = store.require_feedback(learning, data["feedback_id"])
        if feedback.get("evidence_id"):
            existing = next(item for item in learning["evidence"] if item.get("id") == feedback["evidence_id"])
            return {"ok": True, "feedback": feedback, "evidence": existing, "duplicate": True}
        extraction = feedback.get("extraction")
        if extraction is None:
            raise PreferenceValidationError("feedback has no saved extraction")
        group = store.group_by_name(group_name)
        explicit = feedback.get("group_name")
        current_names = {item["name"] for item in store.groups()["groups"]}
        if explicit is not None and explicit in current_names and explicit != group["name"]:
            raise PreferenceValidationError("feedback explicit group is still valid and cannot be replaced")
        evidence_content = extraction["evidence"]
        if any(source["role"] == "unknown" for source in _quote_sources(feedback, evidence_content)):
            raise PreferenceValidationError("evidence supporting_quotes must each come from one selected user/assistant event or successful file change result")
        evidence = {
            "id": new_id("evidence-"),
            "created_at": utc_now(),
            "feedback_id": feedback["id"],
            "group_id": group["id"],
            "group_name": group["name"],
            **evidence_content,
        }
        learning["evidence"].append(evidence)
        feedback["group_name"] = group["name"]
        feedback["status"] = "organized"
        feedback["evidence_id"] = evidence["id"]
        feedback["error"] = None
        store.write_learning(learning)
    return {"ok": True, "feedback": feedback, "evidence": evidence, "duplicate": False}


def _feedback_get(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"feedback_id"}, {"feedback_id"}, "feedback-get")
    learning = store.learning()
    feedback = store.require_feedback(learning, data["feedback_id"])
    evidence = next((item for item in learning["evidence"] if item.get("id") == feedback.get("evidence_id")), None)
    projected = evidence or (feedback.get("extraction") or {}).get("evidence")
    return {"ok": True, "feedback": feedback, "evidence": projected, "quote_sources": _quote_sources(feedback, projected)}


def _feedback_list(store: PreferenceStore) -> dict[str, Any]:
    learning = store.learning()
    return {"ok": True, "feedback": list(reversed(learning["feedback"]))}


def _feedback_evidence(learning: dict[str, Any], feedback: dict[str, Any]) -> dict[str, Any] | None:
    return next((item for item in learning["evidence"] if item.get("id") == feedback.get("evidence_id")), None)


def _reprocess_digest(feedback: dict[str, Any], evidence: dict[str, Any] | None) -> str:
    return digest({"feedback": feedback, "evidence": evidence})


def _group_snapshot(group: dict[str, Any], store: PreferenceStore) -> dict[str, Any]:
    return {
        "id": group["id"],
        "name": group["name"],
        "description": group["description"],
        "base_digest": store.group_digest(group),
    }


def _feedback_reprocess(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    action = checked_text(value.get("action"), "action", maximum=32)
    if action == "prepare":
        data = _strict(value, {"action", "feedback_id"}, {"action", "feedback_id"}, "feedback-reprocess prepare")
        with store.locked():
            learning = store.learning()
            feedback = store.require_feedback(learning, data["feedback_id"])
            evidence = _feedback_evidence(learning, feedback)
            document = store.groups()
            groups_by_id = {item["id"]: item for item in document["groups"]}
            groups_by_name = {item["name"]: item for item in document["groups"]}
            original_group = groups_by_id.get(evidence["group_id"]) if evidence is not None else groups_by_name.get(feedback.get("group_name"))
            return {
                "ok": True,
                "feedback": feedback,
                "evidence": evidence,
                "group": None if original_group is None else _group_snapshot(original_group, store),
                "groups": [_group_snapshot(group, store) for group in document["groups"]],
                "expected_digest": _reprocess_digest(feedback, evidence),
            }
    if action != "apply":
        raise PreferenceValidationError(f"unsupported feedback-reprocess action: {action}")
    required = {"action", "feedback_id", "group_id", "expected_digest", "expected_group_digest", "extraction", "model"}
    data = _strict(value, required, required, "feedback-reprocess apply")
    feedback_id = checked_id(data["feedback_id"], "feedback_id")
    group_id = checked_id(data["group_id"], "group_id")
    expected_digest = checked_text(data["expected_digest"], "expected_digest", maximum=80)
    expected_group_digest = checked_text(data["expected_group_digest"], "expected_group_digest", maximum=80)
    extraction = validate_extraction(data["extraction"])
    model = validate_model(data["model"])
    with store.locked():
        learning = store.learning()
        feedback = store.require_feedback(learning, feedback_id)
        evidence = _feedback_evidence(learning, feedback)
        if _reprocess_digest(feedback, evidence) != expected_digest:
            raise PreferenceValidationError("feedback or evidence changed before reprocess apply")
        document = store.groups()
        group = store.group_by_id(group_id, document)
        if store.group_digest(group) != expected_group_digest:
            raise PreferenceValidationError("preference group changed before reprocess apply")
        groups_by_id = {item["id"]: item for item in document["groups"]}
        groups_by_name = {item["name"]: item for item in document["groups"]}
        fixed_group = groups_by_id.get(evidence["group_id"]) if evidence is not None else groups_by_name.get(feedback.get("group_name"))
        if fixed_group is not None and fixed_group["id"] != group["id"]:
            raise PreferenceValidationError("existing feedback group cannot be replaced")
        had_original_group = evidence is not None or feedback.get("group_name") is not None
        suggested_name = extraction["group"]["name"] if extraction["group"]["certain"] else None
        suggested_group = groups_by_name.get(suggested_name)
        if not had_original_group and suggested_group is not None and suggested_group["id"] != group["id"]:
            raise PreferenceValidationError("certain model group must be used for ungrouped feedback")
        if any(source["role"] == "unknown" for source in _quote_sources(feedback, extraction["evidence"])):
            raise PreferenceValidationError("reprocessed supporting_quotes must each come from one selected user/assistant event or successful file change result")

        evidence_content = extraction["evidence"]
        changed = evidence is None or evidence["group_id"] != group["id"] or any(
            evidence[key] != evidence_content[key]
            for key in ("summary", "actual_behavior", "expected_behavior", "applicability", "supporting_quotes")
        )
        if evidence is None:
            updated_evidence = {
                "id": new_id("evidence-"),
                "created_at": utc_now(),
                "feedback_id": feedback["id"],
                "group_id": group["id"],
                "group_name": group["name"],
                **evidence_content,
            }
            learning["evidence"].append(updated_evidence)
        else:
            updated_evidence = {
                **evidence,
                "group_id": group["id"],
                "group_name": group["name"],
                **evidence_content,
            }
            learning["evidence"] = [updated_evidence if item["id"] == evidence["id"] else item for item in learning["evidence"]]
        updated_feedback = {
            **feedback,
            "model": model,
            "group_name": group["name"],
            "status": "organized",
            "evidence_id": updated_evidence["id"],
            "error": None,
            "extraction": extraction,
        }
        learning["feedback"] = [updated_feedback if item["id"] == feedback["id"] else item for item in learning["feedback"]]
        invalidated = 0
        if changed:
            for proposal in learning["proposals"]:
                if proposal["status"] == "pending" and updated_evidence["id"] in proposal["evidence_ids"]:
                    proposal["status"] = "stale"
                    proposal["resolved_at"] = utc_now()
                    invalidated += 1
        store.write_learning(learning)
    return {
        "ok": True,
        "feedback": updated_feedback,
        "evidence": updated_evidence,
        "invalidated_proposal_count": invalidated,
    }


def _pending_list(store: PreferenceStore) -> dict[str, Any]:
    document = store.groups()
    learning = store.learning()
    groups_by_id = {item["id"]: item for item in document["groups"]}
    valid_proposals = []
    for proposal in reversed(learning["proposals"]):
        if proposal["status"] != "pending":
            continue
        group = groups_by_id.get(proposal["group_id"])
        if group is not None and store.group_digest(group) == proposal["base_digest"]:
            valid_proposals.append(proposal)
    evolution_groups = []
    for group in document["groups"]:
        reviewed = set(learning["reviewed_evidence"].get(group["id"], []))
        new_count = sum(
            item.get("group_id") == group["id"] and item["id"] not in reviewed
            for item in learning["evidence"]
        )
        has_valid = any(item["group_id"] == group["id"] for item in valid_proposals)
        if new_count >= 3 and not has_valid:
            evolution_groups.append({"id": group["id"], "name": group["name"], "new_evidence_count": new_count})
    return {
        "ok": True,
        "feedback": [item for item in reversed(learning["feedback"]) if item["status"] in {"saved", "pending_group", "failed"}],
        "proposals": valid_proposals,
        "evolution_groups": evolution_groups,
    }


def _project_evidence(learning: dict[str, Any], evidence: list[dict[str, Any]]) -> list[dict[str, Any]]:
    feedback_by_id = {item["id"]: item for item in learning["feedback"]}
    projected = []
    for item in evidence:
        feedback = feedback_by_id.get(item["feedback_id"])
        projected.append({
            **item,
            "evaluation": None if feedback is None else {
                "sentiment": feedback["sentiment"],
                "reason": feedback["reason"],
                "quote_sources": _quote_sources(feedback, item),
            },
        })
    return projected


def _manual_evidence_ids(value: Any) -> list[str]:
    if not isinstance(value, list) or not value:
        raise PreferenceValidationError("evidence_ids must be a non-empty list")
    result = [checked_id(item, "evidence_id") for item in value]
    if len(result) != len(set(result)):
        raise PreferenceValidationError("evidence_ids must not contain duplicates")
    return result


def _manual_evolution(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    action = checked_text(value.get("action"), "action", maximum=32)
    if action == "list":
        _strict(value, {"action"}, {"action"}, "manual-evolution list")
        with store.locked():
            document = store.groups()
            learning = store.learning()
            group_ids = {group["id"] for group in document["groups"]}
            evidence = [item for item in learning["evidence"] if item.get("group_id") in group_ids]
            return {
                "ok": True,
                "groups": [_group_snapshot(group, store) for group in document["groups"]],
                "evidence": _project_evidence(learning, evidence),
            }
    if action == "prepare":
        data = _strict(value, {"action", "group_id", "evidence_ids"}, {"action", "group_id", "evidence_ids"}, "manual-evolution prepare")
        group_id = checked_id(data["group_id"], "group_id")
        evidence_ids = _manual_evidence_ids(data["evidence_ids"])
        with store.locked():
            document = store.groups()
            group = store.group_by_id(group_id, document)
            learning = store.learning()
            selected_ids = set(evidence_ids)
            selected = [item for item in learning["evidence"] if item["id"] in selected_ids and item.get("group_id") == group_id]
            if {item["id"] for item in selected} != selected_ids:
                raise PreferenceValidationError("all selected evidence must exist in the target group")
            projected = _project_evidence(learning, selected)
            snapshot = {"group": group, "selected_evidence": projected}
            if len(stable_json(snapshot).encode("utf-8")) > MAX_SELECTED_SNAPSHOT_BYTES:
                raise PreferenceValidationError("manual evolution snapshot exceeds 4 MiB")
            return {
                "ok": True,
                "group": group,
                "evidence": projected,
                "evidence_ids": [item["id"] for item in selected],
                "base_digest": store.group_digest(group),
                "evidence_digest": digest(projected),
            }
    if action != "apply":
        raise PreferenceValidationError(f"unsupported manual-evolution action: {action}")
    fields = {"action", "group_id", "evidence_ids", "base_digest", "evidence_digest", "proposed_rules", "rationale"}
    data = _strict(value, fields, fields, "manual-evolution apply")
    group_id = checked_id(data["group_id"], "group_id")
    evidence_ids = _manual_evidence_ids(data["evidence_ids"])
    base_digest = checked_text(data["base_digest"], "base_digest", maximum=80)
    evidence_digest = checked_text(data["evidence_digest"], "evidence_digest", maximum=80)
    proposed_rules = validate_proposed_rules(data["proposed_rules"])
    rationale = checked_text(data["rationale"], "rationale", maximum=4000)

    def mutate(document: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        group = store.group_by_id(group_id, document)
        if store.group_digest(group) != base_digest:
            raise PreferenceValidationError("preference group changed while manual evolution was running")
        learning = store.learning()
        selected_ids = set(evidence_ids)
        selected = [item for item in learning["evidence"] if item["id"] in selected_ids and item.get("group_id") == group_id]
        if {item["id"] for item in selected} != selected_ids:
            raise PreferenceValidationError("selected manual evolution evidence changed group or no longer exists")
        projected = _project_evidence(learning, selected)
        if digest(projected) != evidence_digest:
            raise PreferenceValidationError("selected manual evolution evidence changed while the model was running")
        replacement = store.build_rule_replacement(group, proposed_rules)
        return store.replace_group(document, replacement), {
            "ok": True,
            "group_id": group_id,
            "group_name": group["name"],
            "rationale": rationale,
        }

    return _mutate_groups(store, "personal-preferences: manually evolve rules", mutate)


def _prepare_evolution(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"group"}, {"group"}, "prepare-evolution")
    group_name = checked_text(data["group"], "group", maximum=128)
    with store.locked():
        document = store.groups()
        group = store.group_by_name(group_name, document)
        learning = store.learning()
        evidence = [item for item in learning["evidence"] if item.get("group_id") == group["id"]]
        pending = store.pending_proposal(learning, group["id"])
        if pending is not None:
            if pending["base_digest"] == store.group_digest(group):
                return {"ok": True, "trigger": False, "pending_proposal": pending}
            pending["status"] = "stale"
            pending["resolved_at"] = utc_now()
            store.write_learning(learning)
        reviewed = set(learning["reviewed_evidence"].get(group["id"], []))
        new_ids = [item["id"] for item in evidence if item["id"] not in reviewed]
        if len(new_ids) < 3:
            return {"ok": True, "trigger": False, "new_evidence_count": len(new_ids), "threshold": 3}
        projected_evidence = _project_evidence(learning, evidence)
        return {
            "ok": True,
            "trigger": True,
            "base_digest": store.group_digest(group),
            "group": group,
            "evidence": projected_evidence,
            "evidence_digest": digest(projected_evidence),
            "new_evidence_ids": new_ids,
        }


def _save_evolution(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    fields = {"group_id", "base_digest", "evidence_digest", "evidence_ids", "proposed_rules", "rationale"}
    data = _strict(value, fields, fields, "save-evolution")
    group_id = checked_id(data["group_id"], "group_id")
    base_digest = checked_text(data["base_digest"], "base_digest", maximum=80)
    evidence_digest = checked_text(data["evidence_digest"], "evidence_digest", maximum=80)
    if not isinstance(data["evidence_ids"], list) or not data["evidence_ids"]:
        raise PreferenceValidationError("evidence_ids must be a non-empty list")
    evidence_ids = [checked_id(item, "evidence_id") for item in data["evidence_ids"]]
    proposed_rules = validate_proposed_rules(data["proposed_rules"])
    rationale = checked_text(data["rationale"], "rationale", maximum=4000)
    with store.locked():
        group = store.group_by_id(group_id)
        if store.group_digest(group) != base_digest:
            raise PreferenceValidationError("preference group changed while the model was running")
        learning = store.learning()
        current_evidence = [item for item in learning["evidence"] if item.get("group_id") == group_id]
        available = {item["id"] for item in current_evidence}
        if set(evidence_ids) != available:
            raise PreferenceValidationError("evolution must include all current group evidence")
        if digest(_project_evidence(learning, current_evidence)) != evidence_digest:
            raise PreferenceValidationError("evolution evidence changed while the model was running")
        if store.pending_proposal(learning, group_id) is not None:
            raise PreferenceValidationError("the group already has a pending rule proposal")
        proposal = {
            "id": new_id("proposal-"),
            "created_at": utc_now(),
            "group_id": group_id,
            "group_name": group["name"],
            "base_digest": base_digest,
            "evidence_ids": evidence_ids,
            "existing_rules": store.active_rule_texts(group),
            "proposed_rules": proposed_rules,
            "rationale": rationale,
            "status": "pending",
            "resolved_at": None,
            "commit": None,
        }
        learning["proposals"].append(proposal)
        store.write_learning(learning)
    return {"ok": True, "proposal": proposal}


def _resolve_evolution(store: PreferenceStore, value: dict[str, Any]) -> dict[str, Any]:
    data = _strict(value, {"proposal_id", "decision"}, {"proposal_id", "decision"}, "resolve-evolution")
    proposal_id = checked_id(data["proposal_id"], "proposal_id")
    if data["decision"] not in {"apply", "reject"}:
        raise PreferenceValidationError("decision must be apply or reject")
    with store.locked():
        learning = store.learning()
        proposal = next((item for item in learning["proposals"] if item.get("id") == proposal_id), None)
        if proposal is None:
            raise PreferenceValidationError("proposal does not exist")
        if proposal.get("status") != "pending":
            return {"ok": True, "proposal": proposal, "duplicate": True}
        group = store.group_by_id(proposal["group_id"])
        current_rules = store.active_rule_texts(group)
        commit = None
        if data["decision"] == "apply":
            already_applied = current_rules == proposal["proposed_rules"] and store.group_digest(group) != proposal["base_digest"]
            if not already_applied:
                if store.group_digest(group) != proposal["base_digest"]:
                    proposal["status"] = "stale"
                    proposal["resolved_at"] = utc_now()
                    store.write_learning(learning)
                    raise PreferenceValidationError("preference group changed before apply; rules were not overwritten")
                document = store.groups()
                replacement = store.build_rule_replacement(group, proposal["proposed_rules"])
                updated = store.replace_group(document, replacement)
                if updated != document:
                    repo = require_clean(store.repo)
                    before_bytes = store.groups_path.read_bytes()
                    try:
                        store.write_groups(updated)
                        commit = commit_groups(repo, "personal-preferences: evolve rules")
                        if proposal["proposed_rules"] != proposal["existing_rules"] and not commit:
                            raise PreferenceGitError("rule evolution did not create a Git commit")
                    except Exception:
                        restore_failed_group_write(repo, before_bytes)
                        raise
            proposal["status"] = "applied"
            proposal["commit"] = commit
        else:
            proposal["status"] = "rejected"
        proposal["resolved_at"] = utc_now()
        learning["reviewed_evidence"][proposal["group_id"]] = list(proposal["evidence_ids"])
        store.write_learning(learning)
    return {"ok": True, "proposal": proposal, "duplicate": False}


def _sync(store: PreferenceStore) -> dict[str, Any]:
    # Network operations happen outside the user-data write lock. Only the
    # local rebase is serialized with group/rule writes.
    assert_sync_scope(store.repo)
    fetched = fetch_remote(store.repo)
    with store.locked():
        pulled = rebase_fetched(store.repo, fetched, store.groups)
    pushed = push_remote(store.repo)
    return {"ok": True, "pulled": pulled, "pushed": pushed, "sync_state": sync_state(store.repo)}


def dispatch(args: argparse.Namespace, stdin_value: dict[str, Any] | None) -> dict[str, Any]:
    store = PreferenceStore(args.data_root)
    if args.command == "init":
        return {"ok": True, "created": store.initialize()}
    store.initialize()
    if args.command == "status":
        return _status(store)
    if args.command == "groups":
        return {"ok": True, "groups": _legacy_groups(store.groups())}
    if args.command == "context":
        return _context(store, stdin_value or {})
    if args.command == "remember":
        return _remember(store, stdin_value or {})
    if args.command == "manage-group":
        return _manage_group(store, stdin_value or {})
    if args.command == "set-activation":
        return _set_activation(store, stdin_value or {})
    if args.command == "sync":
        return _sync(store)
    if args.command == "feedback-create":
        return _feedback_create(store, stdin_value or {})
    if args.command == "feedback-extracted":
        return _feedback_extracted(store, stdin_value or {})
    if args.command == "feedback-fail":
        return _feedback_fail(store, stdin_value or {})
    if args.command == "feedback-complete":
        return _feedback_complete(store, stdin_value or {})
    if args.command == "feedback-get":
        return _feedback_get(store, stdin_value or {})
    if args.command == "feedback-list":
        return _feedback_list(store)
    if args.command == "feedback-reprocess":
        return _feedback_reprocess(store, stdin_value or {})
    if args.command == "pending-list":
        return _pending_list(store)
    if args.command == "manual-evolution":
        return _manual_evolution(store, stdin_value or {})
    if args.command == "prepare-evolution":
        return _prepare_evolution(store, stdin_value or {})
    if args.command == "save-evolution":
        return _save_evolution(store, stdin_value or {})
    if args.command == "resolve-evolution":
        return _resolve_evolution(store, stdin_value or {})
    raise PreferenceValidationError(f"unsupported command: {args.command}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Pi personal preference backend")
    result.add_argument("command", choices=[
        "init", "status", "groups", "context", "remember", "manage-group", "set-activation", "sync",
        "feedback-create", "feedback-extracted", "feedback-fail", "feedback-complete", "feedback-get", "feedback-list", "feedback-reprocess", "pending-list",
        "manual-evolution", "prepare-evolution", "save-evolution", "resolve-evolution",
    ])
    result.add_argument("--stdin", action="store_true")
    result.add_argument("--data-root", type=Path, required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        stdin_value = _stdin_object(args) if args.stdin else None
        output = dispatch(args, stdin_value)
    except PreferenceError as exc:
        print(stable_json({"ok": False, "error": {"code": exc.code, "message": str(exc)}}))
        return 2
    except Exception as exc:  # Keep process failures structured without leaking data.
        print(stable_json({"ok": False, "error": {"code": "internal_error", "message": str(exc)}}))
        return 2
    print(stable_json(output))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
