"""Direct, batch preference evolution for group rules."""

from __future__ import annotations

import difflib
import json
import os
from dataclasses import replace
from pathlib import Path
from typing import Any, Iterable

from .config import PreferenceConfig
from .contracts import (
    EvolutionAction,
    EvolutionChange,
    EvolutionResponse,
    PreferenceEvent,
    PreferenceGroup,
    stable_json_dumps,
    utc_now,
)
from .errors import PreferenceContractError, PreferenceEvolutionError, PreferenceGitError
from .git_sync import (
    begin_generated_transaction,
    commit_generated,
    ensure_generated_transaction_ready,
    pull_rebase,
    push,
    restore_generated_transaction,
    sync_state,
)
from .model_client import MAX_RESPONSE_BYTES, call_openai_compatible
from .sanitizing import sanitize_text
from .store import PreferenceStore, atomic_write_text

PROMPT_VERSION = "personal-preference-group-evolver-v1"
_MAX_RESPONSE_BYTES = MAX_RESPONSE_BYTES


def build_evolver_prompt(events: list[PreferenceEvent], groups: list[PreferenceGroup]) -> str:
    """Build a prompt containing every group and the new evidence batch."""

    payload = {
        "groups": [
            {
                "name": group.name,
                "description": sanitize_text(group.description).text,
                "rules": [sanitize_text(rule).text for rule in group.rules],
            }
            for group in sorted(groups, key=lambda item: (item.name != "global", item.name))
        ],
        "evidence": [
            {
                "id": event.id,
                "group": event.group,
                "signal": event.signal.value,
                "summary": sanitize_text(event.summary).text,
                "task_id": event.task_id,
                "paths": list(event.paths),
            }
            for event in sorted(events, key=lambda item: item.id)
        ],
    }
    return (
        f"You update rules inside existing personal preference groups. Prompt version: {PROMPT_VERSION}.\n"
        "Use only existing groups. Infer only explicit, repeated preferences from the redacted evidence. "
        "Do not create or delete groups. Return JSON only with at most three changes. "
        "Allowed actions are add, replace, delete, and noop. "
        "Each non-noop change must cite evidence_ids. An add supplies group and rule; "
        "a replace supplies group, rule, previous_rule, and evidence_ids; a delete supplies group, rule, "
        "and evidence_ids. Personal preferences remain subordinate to safety, correctness, the current user request, and AGENTS.md.\n\n"
        + stable_json_dumps(payload)
    )


def parse_evolution_response(value: Any) -> EvolutionResponse:
    if isinstance(value, str):
        if len(value.encode("utf-8")) > _MAX_RESPONSE_BYTES:
            raise PreferenceEvolutionError("model response exceeded 512 KiB")
        try:
            value = json.loads(value)
        except json.JSONDecodeError as exc:
            raise PreferenceEvolutionError(f"model returned invalid JSON: {exc}") from exc
    try:
        response = EvolutionResponse.from_dict(value)
    except PreferenceContractError as exc:
        raise PreferenceEvolutionError(str(exc)) from exc
    return EvolutionResponse([
        replace(
            change,
            rule=sanitize_text(change.rule).text if change.rule is not None else None,
            previous_rule=(sanitize_text(change.previous_rule).text
                           if change.previous_rule is not None else None),
        )
        for change in response.changes
    ])


def _event_map(events: Iterable[PreferenceEvent]) -> dict[str, PreferenceEvent]:
    return {event.id: event for event in events}


def _validate_evidence(change: EvolutionChange, event_map: dict[str, PreferenceEvent]) -> list[PreferenceEvent]:
    if change.action is EvolutionAction.NOOP:
        return []
    assert change.group is not None
    missing = sorted(set(change.evidence_ids) - set(event_map))
    if missing:
        raise PreferenceEvolutionError(f"change cites unknown evidence IDs: {missing}")
    evidence = [event_map[event_id] for event_id in change.evidence_ids]
    if any(event.group != change.group for event in evidence):
        raise PreferenceEvolutionError("change group does not match cited evidence")
    return evidence


def apply_evolution_changes(
    groups: Iterable[PreferenceGroup],
    response: EvolutionResponse,
    events: Iterable[PreferenceEvent],
) -> tuple[list[PreferenceGroup], list[dict[str, Any]]]:
    """Apply validated model changes directly to group rule lists."""

    ordered = list(groups)
    current = {group.name: group for group in ordered}
    event_map = _event_map(events)
    results: list[dict[str, Any]] = []
    for change in response.changes:
        if change.action is EvolutionAction.NOOP:
            results.append({"action": "noop"})
            continue
        evidence = _validate_evidence(change, event_map)
        assert change.group is not None and change.rule is not None
        group = current.get(change.group)
        if group is None:
            raise PreferenceEvolutionError(f"change targets unknown preference group: {change.group}")
        rules = list(group.rules)
        if change.action is EvolutionAction.ADD:
            if change.rule in rules:
                raise PreferenceEvolutionError(f"preference rule already exists in group: {change.group}")
            rules.append(change.rule)
            current[change.group] = PreferenceGroup(group.name, group.description, rules)
            results.append({"action": "add", "group": change.group, "rule": change.rule,
                            "evidence_count": len(evidence)})
            continue
        if change.action is EvolutionAction.REPLACE:
            assert change.previous_rule is not None
            if change.previous_rule not in rules:
                raise PreferenceEvolutionError(f"replacement rule does not exist in group: {change.group}")
            if change.rule != change.previous_rule and change.rule in rules:
                raise PreferenceEvolutionError(f"replacement rule already exists in group: {change.group}")
            rules[rules.index(change.previous_rule)] = change.rule
            current[change.group] = PreferenceGroup(group.name, group.description, rules)
            results.append({"action": "replace", "group": change.group, "rule": change.rule,
                            "previous_rule": change.previous_rule, "evidence_count": len(evidence)})
            continue
        if change.action is EvolutionAction.DELETE:
            if change.rule not in rules:
                raise PreferenceEvolutionError(f"preference rule does not exist in group: {change.group}")
            rules.remove(change.rule)
            current[change.group] = PreferenceGroup(group.name, group.description, rules)
            results.append({"action": "delete", "group": change.group, "rule": change.rule,
                            "evidence_count": len(evidence)})
            continue
        raise PreferenceEvolutionError(f"unsupported evolution action: {change.action.value}")
    return [current[group.name] for group in ordered], results


def _groups_diff(repo: Path, groups: list[PreferenceGroup]) -> str:
    relative = "groups.json"
    path = repo / relative
    if path.is_symlink():
        raise PreferenceEvolutionError(f"unsafe generated groups path: {path}")
    if path.exists() and not path.is_file():
        raise PreferenceEvolutionError(f"expected generated groups file: {path}")
    old = path.read_text(encoding="utf-8") if path.exists() else ""
    new = stable_json_dumps({"schema_version": 1, "groups": [group.to_dict() for group in groups]}) + "\n"
    if old == new:
        return ""
    return "".join(difflib.unified_diff(
        old.splitlines(keepends=True),
        new.splitlines(keepends=True),
        fromfile=f"a/{relative}",
        tofile=f"b/{relative}",
    ))


def _model_name(config: PreferenceConfig) -> str:
    return f"{config.provider['name']}/{config.provider['model']}"


def _read_fake_evolution_response() -> Any:
    fixture = os.environ.get("PREFERENCE_MODEL_RESPONSE")
    if fixture is None:
        raise PreferenceEvolutionError("PREFERENCE_MODEL_RESPONSE is required for the fake provider")
    if len(fixture.encode("utf-8")) > _MAX_RESPONSE_BYTES:
        raise PreferenceEvolutionError("PREFERENCE_MODEL_RESPONSE exceeded 512 KiB")
    return fixture


def evolve_preferences(
    data_root: str | Path,
    *,
    dry_run: bool = False,
    model_response: Any | None = None,
) -> dict[str, Any]:
    store = PreferenceStore(data_root)
    config = store.config
    if not config.enabled:
        raise PreferenceEvolutionError("preference evolution is paused")

    transaction = None
    sync_result = {"synced": 0, "discarded": 0}
    if dry_run:
        new_events, cursors = store.load_new_evidence()
        new_events.extend(store.inbox_events())
    else:
        ensure_generated_transaction_ready(store.repo)
        pull_rebase(store.repo)
        transaction = begin_generated_transaction(
            store.repo,
            extra_paths=(store.inbox_path, store.raw_diff_root),
        )
        try:
            sync_result = store.sync_inbox()
            new_events, cursors = store.load_new_evidence()
        except Exception:
            restore_generated_transaction(transaction)
            raise

    events = sorted({event.id: event for event in new_events}.values(), key=lambda item: item.id)
    if not events:
        result: dict[str, Any] = {
            "ok": True,
            "action": "noop",
            "changes": [],
            "diff": "",
            "commit": None,
            "new_evidence": 0,
            "reload_required": False,
            **sync_result,
        }
        if dry_run:
            result["dry_run"] = True
        else:
            version = store.read_version()
            if version["evidence_cursors"] != cursors:
                try:
                    store.write_version(cursors=cursors, model=version.get("model"))
                    result["commit"] = commit_generated(store.repo, "personal-preferences: evidence cursor")
                    if not result["commit"]:
                        raise PreferenceGitError("evidence cursor update did not create a Git commit")
                except Exception:
                    assert transaction is not None
                    restore_generated_transaction(transaction)
                    raise
                result["pushed"] = False
                if config.git_auto_push:
                    try:
                        result["pushed"] = push(store.repo)
                    except PreferenceGitError as exc:
                        result["push_error"] = sanitize_text(str(exc)).text[:500]
                result["sync_state"] = sync_state(store.repo)
        store.write_last_run(result)
        return result

    try:
        groups = store.read_groups()
        prompt = build_evolver_prompt(events, groups)
        if model_response is not None:
            raw_response = model_response
        elif config.provider["name"] == "fake":
            raw_response = _read_fake_evolution_response()
        else:
            raw_response = call_openai_compatible(config, prompt)

        response_path = store.local / "last-model-response.json"
        response_value: Any = {"content": raw_response} if isinstance(raw_response, str) else raw_response
        try:
            response_text = stable_json_dumps(response_value)
        except (TypeError, ValueError) as exc:
            raise PreferenceEvolutionError(f"model response cannot be stored: {exc}") from exc
        atomic_write_text(response_path, sanitize_text(response_text).text + "\n")
        store.write_last_run({
            "ok": True,
            "stage": "model_response",
            "model": _model_name(config),
            "prompt_version": PROMPT_VERSION,
            "new_evidence": len(events),
            "response_path": str(response_path),
        })
        response = parse_evolution_response(raw_response)
        new_groups, changes = apply_evolution_changes(groups, response, events)
        generated_diff = sanitize_text(_groups_diff(store.repo, new_groups)).text
        changed = bool(generated_diff)
        result = {
            "ok": True,
            "action": "changed" if changed else "noop",
            "changes": changes,
            "diff": generated_diff,
            "new_evidence": len(events),
            "commit": None,
            "reload_required": False,
            "model": _model_name(config),
            **sync_result,
        }
        if dry_run:
            result["dry_run"] = True
            store.write_last_run(result)
            return result

        if changed:
            store.write_groups(new_groups)
        store.write_version(cursors=cursors, model=_model_name(config))
        result["commit"] = commit_generated(store.repo, "personal-preferences: generated")
        if not result["commit"]:
            raise PreferenceGitError("preference evolution did not create a Git commit")
    except Exception:
        if transaction is not None:
            restore_generated_transaction(transaction)
        raise

    store.append_metric({"kind": "evolve", "new_evidence": len(events), "changes": len(changes),
                         "groups": len(new_groups), "rules": sum(len(group.rules) for group in new_groups)})
    result["pushed"] = False
    if config.git_auto_push:
        try:
            result["pushed"] = push(store.repo)
        except PreferenceGitError as exc:
            result["push_error"] = sanitize_text(str(exc)).text[:500]
    result["sync_state"] = sync_state(store.repo)
    store.write_last_run(result)
    return result
