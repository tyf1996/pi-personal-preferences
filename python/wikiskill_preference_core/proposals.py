"""Durable proposal jobs, deterministic Gate, review, provenance, and rollback.

Proposal generation is local-only until an exact input/model authorization is
recorded.  Model completion creates candidates only; formal rules change solely
through an explicit reviewed Git transaction.
"""
from __future__ import annotations

import copy
import json
import re
import secrets
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from .contracts import (
    PreferenceGroupV2,
    PreferenceGroupsDocumentV2,
    PreferenceRuleV2,
    groups_document_v2,
    new_id,
    stable_hash,
    stable_json_dumps,
    utc_now,
)
from .errors import (
    PreferenceConflictError,
    PreferenceContractError,
    PreferenceError,
    PreferenceGitError,
    PreferenceIntegrityError,
    PreferenceStorageError,
)
from .evidence import EvidenceStore
from .evolution import GATE_VERSION, PROMPT_VERSION, build_proposal_input, build_proposal_prompt
from .learning_contracts import Change, Proposal, ProposalJob, cas_for, model_usage
from .sanitizing import sanitize_text
from .transactions import PersistentTransaction

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_MAX_REQUEST_RECORDS = 256
_PERMANENT_DISPATCH_ERRORS = {
    "invalid_config": "dispatch_invalid_config",
    "invalid_contract": "dispatch_invalid_contract",
    "integrity_error": "dispatch_integrity_error",
    "internal_error": "dispatch_internal_error",
    "unsupported_action": "dispatch_unsupported_action",
}
_RULE_OPERATION_KINDS = {"remember", "group_management", "proposal_apply", "rollback"}
_OPERATION_EFFECT_KEYS = {"action", "group_id", "group_before", "group_after", "rule_id", "before_rule", "after_rule", "source_kind", "proposal_id", "change_id", "evidence_refs", "decision"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _iso_after(seconds: int) -> str:
    return (_now() + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def _id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise PreferenceContractError(f"{label} must be a path-safe identifier")
    return value


def _digest(value: Any) -> str:
    return f"sha256:{stable_hash(value)}"


def _strict(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or isinstance(value, list) or set(value) != keys:
        raise PreferenceContractError(f"{label} has an invalid schema")
    return dict(value)


def _selection(value: Any) -> dict[str, Any]:
    from .jobs import _selection as feedback_selection
    return feedback_selection(value)


def _json_bytes(value: Any) -> bytes:
    return (stable_json_dumps(value) + "\n").encode("utf-8")


def _ref(value: Any, label: str = "evidence reference") -> dict[str, str]:
    data = _strict(value, {"evidence_id", "revision_id"}, label)
    return {"evidence_id": _id(data["evidence_id"], f"{label}.evidence_id"), "revision_id": _id(data["revision_id"], f"{label}.revision_id")}


def _ref_key(value: Mapping[str, Any]) -> tuple[str, str]:
    return str(value["evidence_id"]), str(value["revision_id"])


def _canonical_refs(values: Iterable[Mapping[str, Any]]) -> list[dict[str, str]]:
    unique: dict[tuple[str, str], dict[str, str]] = {}
    for value in values:
        checked = _ref(value)
        unique[_ref_key(checked)] = checked
    return [unique[key] for key in sorted(unique)]


def candidate_fingerprint(
    group_id: str,
    action: str,
    rule_ref: Mapping[str, Any] | None,
    proposed_text: str | None,
    evidence_refs: Iterable[Mapping[str, Any]],
    opposing_evidence_refs: Iterable[Mapping[str, Any]],
) -> str:
    normalized_rule = None if rule_ref is None else {
        "rule_id": _id(rule_ref.get("rule_id"), "fingerprint rule_id"),
        "revision": rule_ref.get("revision"),
        "text": rule_ref.get("text"),
        "digest": rule_ref.get("digest"),
    }
    return _digest({
        "group_id": _id(group_id, "fingerprint group_id"),
        "action": action,
        "rule_ref": normalized_rule,
        "proposed_text": proposed_text,
        "evidence_refs": _canonical_refs(evidence_refs),
        "opposing_evidence_refs": _canonical_refs(opposing_evidence_refs),
    })


def _change_fingerprint(proposal: Mapping[str, Any], change: Mapping[str, Any]) -> str:
    return candidate_fingerprint(
        str(proposal["group_id"]), str(change["action"]), change.get("rule_ref"),
        change.get("proposed_text"), change.get("evidence_refs", []), change.get("opposing_evidence_refs", []),
    )


def _proposal_state(changes: Iterable[Mapping[str, Any]]) -> str:
    states = [str(item["state"]) for item in changes]
    for state in ("pending_review", "deferred", "stale", "blocked", "rejected", "applied"):
        if state in states:
            return state
    raise PreferenceIntegrityError("proposal has no change state")


def _git_bytes(repo: Path, args: list[str], *, check: bool = True) -> bytes:
    try:
        result = subprocess.run(
            ["git", "-C", str(repo), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            check=False, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PreferenceGitError(f"cannot inspect preference Git history: {exc}") from exc
    if check and result.returncode != 0:
        raise PreferenceGitError(sanitize_text(result.stderr.decode("utf-8", errors="replace")).text[:500])
    return result.stdout


def _committed_groups(repo: Path, revision: str) -> dict[str, Any]:
    try:
        raw = json.loads(_git_bytes(repo, ["show", f"{revision}:groups.json"]).decode("utf-8"))
        return PreferenceGroupsDocumentV2.from_dict(raw).to_dict()
    except (UnicodeDecodeError, json.JSONDecodeError, PreferenceContractError) as exc:
        raise PreferenceIntegrityError("operation commit groups blob is invalid") from exc


def _operation_group_view(document: Mapping[str, Any], effects: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    group_ids = {str(item["group_id"]) for item in effects}
    return {
        "schema_version": 2,
        "groups": [copy.deepcopy(item) for item in document.get("groups", []) if item.get("id") in group_ids],
    }


def _validate_operation_effects(value: Mapping[str, Any], before: Mapping[str, Any], after: Mapping[str, Any]) -> None:
    effects = value["effects"]
    expected = build_group_effects(
        before, after, source_kind=str(value["source_kind"]),
        proposal_id=value["proposal_id"] if isinstance(value["proposal_id"], str) else None,
    )
    structural_keys = ("action", "group_id", "group_before", "group_after", "rule_id", "before_rule", "after_rule")
    expected_structures = [tuple(stable_json_dumps(item[key]) for key in structural_keys) for item in expected]
    actual_structures = [tuple(stable_json_dumps(item[key]) for key in structural_keys) for item in effects]
    if sorted(actual_structures) != sorted(expected_structures):
        raise PreferenceIntegrityError("operation effects do not describe the committed groups diff")
    if len(actual_structures) != len(set(actual_structures)):
        raise PreferenceIntegrityError("operation effects contain duplicates")
    if any(effect["source_kind"] != value["source_kind"] for effect in effects):
        raise PreferenceIntegrityError("operation effect source kind does not match operation")
    union_refs = _canonical_refs(ref for effect in effects for ref in effect["evidence_refs"])
    if union_refs != _canonical_refs(value["evidence_refs"]):
        raise PreferenceIntegrityError("operation evidence refs do not match effect refs")
    if value["kind"] == "proposal_apply":
        if value["reverts_operation_id"] is not None:
            raise PreferenceIntegrityError("proposal apply cannot identify a rollback target")
        if before == after or not isinstance(value["proposal_id"], str):
            raise PreferenceIntegrityError("proposal apply must change groups for one proposal")
        rule_effects = [item for item in effects if item["rule_id"] is not None]
        effect_change_ids = [item["change_id"] for item in rule_effects]
        if any(not isinstance(item, str) for item in effect_change_ids) or sorted(effect_change_ids) != sorted(value["change_ids"]):
            raise PreferenceIntegrityError("proposal apply change IDs do not match rule effects")
        if len(value["decision_fingerprints"]) != len(value["change_ids"]) or len(set(value["decision_fingerprints"])) != len(value["decision_fingerprints"]):
            raise PreferenceIntegrityError("proposal apply requires one unique candidate fingerprint per change")
        for effect in effects:
            if effect["proposal_id"] != value["proposal_id"]:
                raise PreferenceIntegrityError("proposal apply effect ownership is invalid")
            if effect["rule_id"] is None:
                if effect["change_id"] is not None or effect["evidence_refs"] or effect["decision"] is not None:
                    raise PreferenceIntegrityError("proposal apply group effect contains change metadata")
            elif effect["decision"] not in {"accepted", "accepted_with_edits"}:
                raise PreferenceIntegrityError("proposal apply rule effect has no accepted decision")
    elif value["kind"] == "proposal_reject":
        if before != after or effects or value["proposal_id"] is not None or value["change_ids"] or value["evidence_refs"] or not value["decision_fingerprints"] or value["reverts_operation_id"] is not None:
            raise PreferenceIntegrityError("proposal rejection operation is not minimal")
    else:
        if value["proposal_id"] is not None or value["change_ids"] or value["evidence_refs"] or value["decision_fingerprints"]:
            raise PreferenceIntegrityError("manual or rollback operation contains proposal review metadata")
        if value["kind"] == "rollback":
            if value["reverts_operation_id"] is None:
                raise PreferenceIntegrityError("rollback operation requires an exact target")
        elif value["reverts_operation_id"] is not None:
            raise PreferenceIntegrityError("non-rollback operation cannot identify a rollback target")
        for effect in effects:
            if effect["proposal_id"] is not None or effect["change_id"] is not None or effect["evidence_refs"] or effect["decision"] is not None:
                raise PreferenceIntegrityError("manual or rollback effect contains proposal review metadata")


def _validate_groups_history(repo: Path, operation_commits: set[str]) -> None:
    group_commits = _git_bytes(repo, ["log", "--format=%H", "HEAD", "--", "groups.json"]).decode("ascii").splitlines()
    for commit in group_commits:
        if commit in operation_commits:
            continue
        row = _git_bytes(repo, ["rev-list", "--parents", "-n", "1", commit]).decode("ascii").strip().split()
        subject = _git_bytes(repo, ["show", "-s", "--format=%s", commit]).decode("utf-8", errors="replace").strip()
        if len(row) == 1 and subject.startswith("personal-preferences: initialize ") and re.search(r"\[preference-transaction: [A-Za-z0-9._-]+\]$", subject):
            continue
        raise PreferenceIntegrityError("groups history contains an unknown operation commit")


def load_operation_records(root: str | Path) -> list[dict[str, Any]]:
    from .config import PreferenceConfig
    resolved_root = Path(root).resolve()
    repo = PreferenceConfig.load(resolved_root).repo_root
    directory = repo / "changes"
    head = _git_bytes(repo, ["rev-parse", "HEAD"]).decode("ascii").strip()
    tracked = _git_bytes(repo, ["ls-tree", "-r", "--name-only", "HEAD", "--", "changes"]).decode("utf-8").splitlines()
    if not directory.exists():
        if tracked:
            raise PreferenceIntegrityError("committed preference operations are missing from the worktree")
        _validate_groups_history(repo, set())
        return []
    if directory.is_symlink() or not directory.is_dir():
        raise PreferenceIntegrityError("preference change history must be a regular directory")
    worktree_names = {
        path.name for path in directory.iterdir()
        if path.is_file() and not path.is_symlink() and path.suffix == ".json"
    }
    head_names = {
        Path(item).name for item in tracked
        if item.startswith("changes/") and item.endswith(".json")
    }
    if worktree_names != head_names:
        raise PreferenceIntegrityError("preference operation worktree does not match committed HEAD")
    added_names = {
        Path(item).name for item in _git_bytes(
            repo, ["log", "--diff-filter=A", "--name-only", "--format=", "HEAD", "--", "changes"],
        ).decode("utf-8").splitlines()
        if item.startswith("changes/") and item.endswith(".json")
    }
    if added_names != head_names:
        raise PreferenceIntegrityError("preference operation history deleted or replaced an immutable record")
    result: list[dict[str, Any]] = []
    group_operation_commits: set[str] = set()
    for path in sorted(directory.iterdir(), key=lambda item: item.name):
        if path.is_symlink() or not path.is_file() or path.suffix != ".json" or not _ID_RE.fullmatch(path.stem):
            raise PreferenceIntegrityError(f"unsafe preference change history entry: {path.name}")
        try:
            raw_bytes = path.read_bytes()
            value = json.loads(raw_bytes.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError(f"preference change history is unreadable: {path}") from exc
        required = {
            "schema_version", "operation_id", "transaction_id", "created_at", "kind", "source_kind",
            "proposal_id", "change_ids", "evidence_refs", "effects", "groups_before_digest",
            "groups_after_digest", "reverts_operation_id", "decision_fingerprints",
        }
        if not isinstance(value, dict) or set(value) != required or value.get("schema_version") != 1 or value.get("operation_id") != path.stem:
            raise PreferenceIntegrityError("preference change operation schema or identity is invalid")
        _id(value["operation_id"], "operation_id")
        transaction_id = _id(value["transaction_id"], "transaction_id")
        _parse_time(value["created_at"])
        if value["kind"] not in {*_RULE_OPERATION_KINDS, "proposal_reject"}:
            raise PreferenceIntegrityError("preference change operation kind is invalid")
        expected_sources = {
            "remember": "user_remember", "group_management": "group_management",
            "proposal_apply": "proposal_accept", "proposal_reject": "proposal_reject", "rollback": "rollback",
        }
        if value["source_kind"] != expected_sources[value["kind"]]:
            raise PreferenceIntegrityError("preference change source kind does not match operation kind")
        if value["proposal_id"] is not None: _id(value["proposal_id"], "operation proposal_id")
        if not isinstance(value["change_ids"], list): raise PreferenceIntegrityError("operation change IDs are invalid")
        change_ids = [_id(item, "operation change_id") for item in value["change_ids"]]
        if len(change_ids) != len(set(change_ids)): raise PreferenceIntegrityError("operation change IDs contain duplicates")
        if not isinstance(value["evidence_refs"], list): raise PreferenceIntegrityError("operation evidence refs are invalid")
        checked_operation_refs = [_ref(item, "operation evidence reference") for item in value["evidence_refs"]]
        if len(checked_operation_refs) != len({_ref_key(item) for item in checked_operation_refs}):
            raise PreferenceIntegrityError("operation evidence refs contain duplicates")
        if not isinstance(value["decision_fingerprints"], list) or any(not isinstance(item, str) or not _DIGEST_RE.fullmatch(item) for item in value["decision_fingerprints"]):
            raise PreferenceIntegrityError("operation candidate fingerprints are invalid")
        if len(value["decision_fingerprints"]) != len(set(value["decision_fingerprints"])):
            raise PreferenceIntegrityError("operation candidate fingerprints contain duplicates")
        if not isinstance(value["effects"], list): raise PreferenceIntegrityError("operation effects are invalid")
        for effect in value["effects"]:
            if not isinstance(effect, dict) or set(effect) != _OPERATION_EFFECT_KEYS:
                raise PreferenceIntegrityError("operation effect schema is invalid")
            _id(effect["group_id"], "operation effect group_id")
            if effect["rule_id"] is not None: _id(effect["rule_id"], "operation effect rule_id")
            if effect["proposal_id"] is not None: _id(effect["proposal_id"], "operation effect proposal_id")
            if effect["change_id"] is not None: _id(effect["change_id"], "operation effect change_id")
            if not isinstance(effect["evidence_refs"], list): raise PreferenceIntegrityError("operation effect evidence refs are invalid")
            checked_effect_refs = [_ref(item, "operation effect evidence reference") for item in effect["evidence_refs"]]
            if len(checked_effect_refs) != len({_ref_key(item) for item in checked_effect_refs}):
                raise PreferenceIntegrityError("operation effect evidence refs contain duplicates")
        for key in ("groups_before_digest", "groups_after_digest"):
            if not isinstance(value[key], str) or not _DIGEST_RE.fullmatch(value[key]):
                raise PreferenceIntegrityError("operation group digest is invalid")
        if value["reverts_operation_id"] is not None: _id(value["reverts_operation_id"], "reverts_operation_id")

        relative = f"changes/{path.name}"
        commits = _git_bytes(repo, ["log", "--follow", "--format=%H", "--", relative]).decode("ascii").splitlines()
        if len(commits) != 1:
            raise PreferenceIntegrityError("operation record must be created once and remain immutable")
        commit = commits[0]
        committed_blob = _git_bytes(repo, ["show", f"{commit}:{relative}"])
        if committed_blob != raw_bytes:
            raise PreferenceIntegrityError("operation record differs from its immutable creation commit")
        ancestor_result = subprocess.run(
            ["git", "-C", str(repo), "merge-base", "--is-ancestor", commit, head],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, timeout=120,
        )
        if ancestor_result.returncode != 0:
            raise PreferenceIntegrityError("operation creation commit is not an ancestor of current HEAD")
        commit_row = _git_bytes(repo, ["rev-list", "--parents", "-n", "1", commit]).decode("ascii").strip().split()
        if len(commit_row) != 2:
            raise PreferenceIntegrityError("operation creation commit must have exactly one parent")
        parent = commit_row[1]
        subject = _git_bytes(repo, ["show", "-s", "--format=%s", commit]).decode("utf-8", errors="replace").strip()
        subject_prefixes = {
            "remember": "personal-preferences: remember ",
            "group_management": "personal-preferences: group ",
            "proposal_apply": "personal-preferences: apply proposal ",
            "proposal_reject": "personal-preferences: proposal reject ",
            "rollback": "personal-preferences: rollback ",
        }
        marker = f"[preference-transaction: {transaction_id}]"
        if not subject.startswith(subject_prefixes[value["kind"]]) or not subject.endswith(marker) or subject.count(marker) != 1:
            raise PreferenceIntegrityError("operation creation commit lacks its recognized transaction subject and marker")
        changed_paths = set(_git_bytes(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).decode("utf-8").splitlines())
        expected_paths = {relative} if value["kind"] == "proposal_reject" else {relative, "groups.json"}
        if changed_paths != expected_paths:
            raise PreferenceIntegrityError("operation creation commit changed unexpected paths")
        before = _committed_groups(repo, parent)
        after = _committed_groups(repo, commit)
        if _digest(_operation_group_view(before, value["effects"])) != value["groups_before_digest"] or _digest(_operation_group_view(after, value["effects"])) != value["groups_after_digest"]:
            raise PreferenceIntegrityError("operation affected-group digests do not match commit parent/after blobs")
        _validate_operation_effects(value, before, after)
        if value["kind"] != "proposal_reject":
            group_operation_commits.add(commit)
        result.append(copy.deepcopy(value))
    _validate_groups_history(repo, group_operation_commits)
    return result


def build_group_effects(
    before: Mapping[str, Any],
    after: Mapping[str, Any],
    *,
    source_kind: str,
    proposal_id: str | None = None,
    change_details: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Return minimal group/rule before-after audit effects."""

    before_groups = {item["id"]: item for item in before.get("groups", []) if isinstance(item, dict)}
    after_groups = {item["id"]: item for item in after.get("groups", []) if isinstance(item, dict)}
    effects: list[dict[str, Any]] = []
    detail_by_rule = dict(change_details or {})
    for group_id in sorted(set(before_groups) | set(after_groups)):
        old_group = before_groups.get(group_id)
        new_group = after_groups.get(group_id)
        old_rules = {item["id"]: item for item in (old_group or {}).get("rules", [])}
        new_rules = {item["id"]: item for item in (new_group or {}).get("rules", [])}
        if old_group is None or new_group is None or {
            key: old_group.get(key) for key in ("name", "description", "revision")
        } != {key: new_group.get(key) for key in ("name", "description", "revision")}:
            effects.append({
                "action": "group_create" if old_group is None else "group_delete" if new_group is None else "group_update",
                "group_id": group_id,
                "group_before": copy.deepcopy(old_group),
                "group_after": copy.deepcopy(new_group),
                "rule_id": None,
                "before_rule": None,
                "after_rule": None,
                "source_kind": source_kind,
                "proposal_id": proposal_id,
                "change_id": None,
                "evidence_refs": [],
                "decision": None,
            })
        for rule_id in sorted(set(old_rules) | set(new_rules)):
            old_rule = old_rules.get(rule_id)
            new_rule = new_rules.get(rule_id)
            if old_rule == new_rule:
                continue
            detail = detail_by_rule.get(rule_id, {})
            effects.append({
                "action": "add" if old_rule is None else "delete" if new_rule is None else "replace",
                "group_id": group_id,
                "group_before": None,
                "group_after": None,
                "rule_id": rule_id,
                "before_rule": copy.deepcopy(old_rule),
                "after_rule": copy.deepcopy(new_rule),
                "source_kind": source_kind,
                "proposal_id": proposal_id,
                "change_id": detail.get("change_id"),
                "evidence_refs": copy.deepcopy(detail.get("evidence_refs", [])),
                "decision": detail.get("decision"),
            })
    return effects


def operation_record(
    *,
    operation_id: str,
    transaction_id: str,
    kind: str,
    source_kind: str,
    before_groups: Mapping[str, Any],
    after_groups: Mapping[str, Any],
    effects: list[dict[str, Any]],
    proposal_id: str | None = None,
    change_ids: Iterable[str] = (),
    evidence_refs: Iterable[Mapping[str, Any]] = (),
    reverts_operation_id: str | None = None,
    decision_fingerprints: Iterable[str] = (),
) -> dict[str, Any]:
    checked_id = _id(operation_id, "operation_id")
    if kind not in {*_RULE_OPERATION_KINDS, "proposal_reject"}:
        raise PreferenceContractError("operation kind is unsupported")
    record = {
        "schema_version": 1,
        "operation_id": checked_id,
        "transaction_id": _id(transaction_id, "transaction_id"),
        "created_at": utc_now(),
        "kind": kind,
        "source_kind": _id(source_kind, "source_kind"),
        "proposal_id": None if proposal_id is None else _id(proposal_id, "proposal_id"),
        "change_ids": [_id(item, "change_id") for item in change_ids],
        "evidence_refs": [_ref(item) for item in evidence_refs],
        "effects": copy.deepcopy(effects),
        "groups_before_digest": _digest(_operation_group_view(before_groups, effects)),
        "groups_after_digest": _digest(_operation_group_view(after_groups, effects)),
        "reverts_operation_id": None if reverts_operation_id is None else _id(reverts_operation_id, "reverts_operation_id"),
        "decision_fingerprints": list(decision_fingerprints),
    }
    if any(not isinstance(item, str) or not _DIGEST_RE.fullmatch(item) for item in record["decision_fingerprints"]):
        raise PreferenceContractError("decision_fingerprints must contain sha256 digests")
    if len(record["decision_fingerprints"]) != len(set(record["decision_fingerprints"])):
        raise PreferenceContractError("decision_fingerprints must not contain duplicates")
    return record


def generated_transaction_id(snapshot: Any) -> str:
    journal = getattr(snapshot, "journal", None)
    if journal is None:
        raise PreferenceIntegrityError("operation requires a persistent Git transaction")
    return _id(journal.transaction_id, "transaction_id")


def write_operation_path(root: str | Path, record: Mapping[str, Any]) -> Path:
    from .config import PreferenceConfig
    from .store import atomic_write_text
    path = PreferenceConfig.load(Path(root).resolve()).repo_root / "changes" / f"{_id(record.get('operation_id'), 'operation_id')}.json"
    atomic_write_text(path, stable_json_dumps(dict(record)) + "\n")
    return path


class ProposalStore:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.local = self.root / "local"
        self.jobs_path = self.local / "proposal-jobs.json"
        self.proposals_path = self.local / "proposals.json"
        self.state_path = self.local / "proposal-state.json"
        self.consent_path = self.local / "proposal-consent.json"
        self.decisions_path = self.local / "decisions.json"
        self.receipts_path = self.local / "proposal-receipts.json"
        self.delete_confirmations_path = self.local / "delete-opposition-confirmations.json"
        self.worker_path = self.local / "worker.json"
        self.learning_state_path = self.local / "learning-state.json"

    def _state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"schema_version": 1, "collection_revision": 0, "requests": {}}
        if self.state_path.is_symlink() or not self.state_path.is_file():
            raise PreferenceIntegrityError("proposal state must be a regular file")
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("proposal state is unreadable") from exc
        if not isinstance(value, dict) or set(value) != {"schema_version", "collection_revision", "requests"} or value.get("schema_version") != 1:
            raise PreferenceIntegrityError("proposal state has an invalid schema")
        if type(value["collection_revision"]) is not int or value["collection_revision"] < 0 or not isinstance(value["requests"], dict) or len(value["requests"]) > _MAX_REQUEST_RECORDS:
            raise PreferenceIntegrityError("proposal state is invalid")
        return value

    def _jobs(self) -> list[dict[str, Any]]:
        if not self.jobs_path.exists():
            return []
        if self.jobs_path.is_symlink() or not self.jobs_path.is_file():
            raise PreferenceIntegrityError("proposal jobs must be a regular file")
        try:
            rows = json.loads(self.jobs_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("proposal jobs are unreadable") from exc
        if not isinstance(rows, list):
            raise PreferenceIntegrityError("proposal jobs must be a list")
        return [ProposalJob.from_dict(item).to_dict() for item in rows]

    def _proposals(self) -> list[dict[str, Any]]:
        if not self.proposals_path.exists():
            return []
        if self.proposals_path.is_symlink() or not self.proposals_path.is_file():
            raise PreferenceIntegrityError("proposals must be a regular file")
        try:
            rows = json.loads(self.proposals_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("proposals are unreadable") from exc
        if not isinstance(rows, list):
            raise PreferenceIntegrityError("proposals must be a list")
        return [Proposal.from_dict(item).to_dict() for item in rows]

    def _decisions(self) -> list[dict[str, Any]]:
        if not self.decisions_path.exists():
            return []
        if self.decisions_path.is_symlink() or not self.decisions_path.is_file():
            raise PreferenceIntegrityError("proposal decisions must be a regular file")
        try:
            rows = json.loads(self.decisions_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("proposal decisions are unreadable") from exc
        if not isinstance(rows, list):
            raise PreferenceIntegrityError("proposal decisions must be a list")
        required = {"decision_id", "proposal_id", "change_id", "decision", "decided_at", "reason", "fingerprint", "operation_id"}
        for item in rows:
            if not isinstance(item, dict) or set(item) != required:
                raise PreferenceIntegrityError("proposal decision schema is invalid")
            if item["operation_id"] is not None:
                _id(item["operation_id"], "proposal decision operation_id")
        return copy.deepcopy(rows)

    def _receipts(self) -> list[dict[str, Any]]:
        if not self.receipts_path.exists():
            return []
        if self.receipts_path.is_symlink() or not self.receipts_path.is_file():
            raise PreferenceIntegrityError("proposal receipts must be a regular file")
        try:
            rows = json.loads(self.receipts_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("proposal receipts are unreadable") from exc
        if not isinstance(rows, list):
            raise PreferenceIntegrityError("proposal receipts must be a list")
        return copy.deepcopy(rows)

    def _delete_confirmations(self) -> list[dict[str, Any]]:
        if not self.delete_confirmations_path.exists():
            return []
        if self.delete_confirmations_path.is_symlink() or not self.delete_confirmations_path.is_file():
            raise PreferenceIntegrityError("delete opposition confirmations must be a regular file")
        try:
            rows = json.loads(self.delete_confirmations_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("delete opposition confirmations are unreadable") from exc
        required = {"confirmation_id", "proposal_id", "change_id", "group_id", "rule_ref", "evidence_ref", "origin_task_key", "confirmed_at"}
        if not isinstance(rows, list):
            raise PreferenceIntegrityError("delete opposition confirmations must be a list")
        for item in rows:
            if not isinstance(item, dict) or set(item) != required:
                raise PreferenceIntegrityError("delete opposition confirmation schema is invalid")
            for key in ("confirmation_id", "proposal_id", "change_id", "group_id", "origin_task_key"):
                _id(item[key], f"delete confirmation {key}")
            rule_ref = item["rule_ref"]
            if not isinstance(rule_ref, dict) or set(rule_ref) != {"rule_id", "revision", "text", "digest"}:
                raise PreferenceIntegrityError("delete confirmation rule_ref is invalid")
            _id(rule_ref["rule_id"], "delete confirmation rule_id")
            if type(rule_ref["revision"]) is not int or rule_ref["revision"] < 1 or not isinstance(rule_ref["text"], str) or not isinstance(rule_ref["digest"], str) or not _DIGEST_RE.fullmatch(rule_ref["digest"]):
                raise PreferenceIntegrityError("delete confirmation exact rule revision is invalid")
            _ref(item["evidence_ref"], "delete confirmation evidence_ref")
            _parse_time(item["confirmed_at"])
        return copy.deepcopy(rows)

    def _cas(self, proposals: list[dict[str, Any]] | None = None, jobs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        return cas_for("proposals", self._state()["collection_revision"], {
            "proposals": proposals if proposals is not None else self._proposals(),
            "jobs": jobs if jobs is not None else self._jobs(),
        }).to_dict()

    def _commit(self, writes: Mapping[Path, bytes | None], *, request: tuple[str, str, Mapping[str, Any]] | None = None) -> None:
        state = copy.deepcopy(self._state())
        state["collection_revision"] += 1
        if request is not None:
            request_id, input_digest, result = request
            records = state["requests"]
            records[request_id] = {"input_digest": input_digest, "data": copy.deepcopy(dict(result))}
            while len(records) > _MAX_REQUEST_RECORDS:
                records.pop(next(iter(records)))
        all_writes = dict(writes)
        all_writes[self.state_path] = _json_bytes(state)
        transaction = PersistentTransaction.begin_local(self.root, all_writes)
        try:
            transaction.apply()
            transaction.commit_local()
        except Exception:
            transaction.rollback()
            raise

    def _request_result(self, request_id: str, input_digest: str) -> dict[str, Any] | None:
        record = self._state()["requests"].get(_id(request_id, "request_id"))
        if record is None:
            return None
        if not isinstance(record, dict) or record.get("input_digest") != input_digest:
            raise PreferenceConflictError("request_id was already used with different proposal input")
        return copy.deepcopy(record["data"])

    def _worker(self) -> dict[str, Any] | None:
        if not self.worker_path.exists():
            return None
        if self.worker_path.is_symlink() or not self.worker_path.is_file():
            raise PreferenceIntegrityError("worker lease must be a regular file")
        try:
            value = json.loads(self.worker_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("worker lease is unreadable") from exc
        data = _strict(value, {"schema_version", "owner_id", "token", "job_id", "generation", "expires_at", "renewed_at"}, "worker lease")
        if data["schema_version"] != 1:
            raise PreferenceIntegrityError("worker lease schema is invalid")
        return data

    @staticmethod
    def _authorization_scope(value: Mapping[str, Any]) -> dict[str, Any]:
        if value.get("stage") != "proposals":
            raise PreferenceContractError("proposal authorization stage must be proposals")
        scope = value.get("scope")
        if scope not in {"single", "new_evidence"}:
            raise PreferenceContractError("proposal authorization scope is invalid")
        group_ids = value.get("group_ids")
        if (not isinstance(group_ids, list) or not group_ids
                or any(not isinstance(item, str) for item in group_ids)):
            raise PreferenceContractError("proposal authorization group_ids must be non-empty")
        checked_groups = [_id(item, "proposal authorization group_id") for item in group_ids]
        if len(checked_groups) != len(set(checked_groups)):
            raise PreferenceContractError("proposal authorization group_ids must be unique")
        signature = value.get("input_signature")
        if scope == "single":
            if len(checked_groups) != 1 or not isinstance(signature, str) or not _DIGEST_RE.fullmatch(signature):
                raise PreferenceContractError("single proposal authorization requires one group and an exact signature")
        elif signature is not None:
            raise PreferenceContractError("new-evidence proposal authorization cannot contain a single input signature")
        return {"stage": "proposals", "scope": scope, "group_ids": checked_groups, "input_signature": signature}

    @staticmethod
    def _consent_allows(consent: Mapping[str, Any], built: Mapping[str, Any], revision: int) -> bool:
        return bool(
            consent["allowed"]
            and consent["revision"] == revision
            and consent["model_selection"] == built["model_selection"]
            and built["payload"]["group"]["id"] in consent["group_ids"]
            and (consent["scope"] == "new_evidence" or consent["input_signature"] == built["input_signature"])
        )

    def _consent(self) -> dict[str, Any]:
        if not self.consent_path.exists() or self.consent_path.is_symlink():
            raise PreferenceContractError("no proposal-send authorization exists")
        try:
            value = json.loads(self.consent_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("proposal-send authorization is unreadable") from exc
        data = _strict(value, {"schema_version", "revision", "allowed", "stage", "scope", "group_ids", "input_signature", "model_selection"}, "proposal authorization")
        if data["schema_version"] != 1 or type(data["revision"]) is not int or data["revision"] < 1 or not isinstance(data["allowed"], bool):
            raise PreferenceContractError("proposal authorization is invalid")
        data.update(self._authorization_scope(data))
        data["model_selection"] = _selection(data["model_selection"])
        return data

    def authorize(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"revision", "allowed", "stage", "scope", "group_ids", "input_signature", "model_selection"}, "proposal authorization")
        if type(data["revision"]) is not int or data["revision"] < 1 or not isinstance(data["allowed"], bool):
            raise PreferenceContractError("proposal authorization revision is invalid")
        scoped = self._authorization_scope(data)
        selection = _selection(data["model_selection"])
        previous = self._consent() if self.consent_path.exists() else None
        comparable = {"allowed": data["allowed"], **scoped, "model_selection": selection}
        if previous is not None:
            if data["revision"] < previous["revision"]:
                raise PreferenceContractError("proposal authorization revision must be monotonic")
            if data["revision"] == previous["revision"] and any(comparable[key] != previous[key] for key in comparable):
                raise PreferenceConflictError("proposal authorization revision conflicts")
        consent = {"schema_version": 1, "revision": data["revision"], **comparable}
        self._commit({self.consent_path: _json_bytes(consent)})
        return {"authorization": consent}, self._cas()

    def _history_projection(self, group_id: str, *, exclude_operation_ids: set[str] | None = None) -> tuple[list[dict[str, Any]], list[str]]:
        operations = load_operation_records(self.root)
        excluded = exclude_operation_ids or set()
        relevant = [item for item in operations if item["operation_id"] not in excluded and (item["kind"] == "proposal_reject" or any(effect.get("group_id") == group_id for effect in item["effects"]))]
        active_revision_ids = {
            row["revision"]["revision_id"]
            for row in EvidenceStore(self.root).view()["evidence"]
            if row["status"] == "active" and isinstance(row.get("revision"), dict)
        }
        from .store import PreferenceStore
        group = next(item for item in PreferenceStore(self.root).read_groups_v2() if item.id == group_id)
        sourced_rules: set[str] = set()
        missing: list[str] = []
        for operation in relevant:
            for effect in operation["effects"]:
                after_rule = effect.get("after_rule")
                if isinstance(after_rule, dict) and any(rule.id == after_rule.get("id") and rule.revision == after_rule.get("revision") for rule in group.rules):
                    sourced_rules.add(str(after_rule["id"]))
                    for ref in effect.get("evidence_refs", []):
                        if isinstance(ref, dict) and ref.get("revision_id") not in active_revision_ids:
                            missing.append(f"{ref.get('evidence_id')}:{ref.get('revision_id')}")
        for rule in group.rules:
            if rule.id not in sourced_rules:
                missing.append(f"rule-source:{rule.id}:{rule.revision}")
        relevant.sort(key=lambda item: (item["created_at"], item["operation_id"]))
        projection = [{
            "operation_id": item["operation_id"], "created_at": item["created_at"], "kind": item["kind"],
            "source_kind": item["source_kind"], "proposal_id": item["proposal_id"], "change_ids": item["change_ids"],
            "evidence_refs": item["evidence_refs"], "effects": item["effects"], "reverts_operation_id": item["reverts_operation_id"],
            "decision_fingerprints": item["decision_fingerprints"],
        } for item in relevant]
        return projection, sorted(set(missing))

    def _input(
        self,
        group_id: Any,
        model_selection: Any,
        *,
        exclude_decision_proposal_id: str | None = None,
        exclude_operation_ids: set[str] | None = None,
    ) -> dict[str, Any]:
        checked_group = _id(group_id, "group_id")
        selection = _selection(model_selection)
        from .store import PreferenceStore
        groups = PreferenceStore(self.root).read_groups_v2()
        group = next((item for item in groups if item.id == checked_group), None)
        if group is None:
            raise PreferenceContractError("proposal group does not exist")
        evidence_store = EvidenceStore(self.root)
        evidence_view = evidence_store.view()["evidence"]
        all_revisions, _local_ids, _repo_ids = evidence_store.revisions()
        relevant_evidence_ids = {
            revision["evidence_id"] for revision in all_revisions.values()
            if revision.get("group_id") == checked_group
        }
        heads = [{"evidence_id": row["evidence_id"], "heads": list(row["heads"]), "status": row["status"]} for row in evidence_view if row["evidence_id"] in relevant_evidence_ids]
        revisions = [row["revision"] for row in evidence_view if row["status"] == "active" and isinstance(row.get("revision"), dict) and row["revision"].get("group_id") == checked_group]
        proposal_groups = {proposal["proposal_id"]: proposal["group_id"] for proposal in self._proposals()}
        decisions = [
            item for item in self._decisions()
            if proposal_groups.get(item["proposal_id"]) == checked_group
            and item["proposal_id"] != exclude_decision_proposal_id
        ]
        history, missing = self._history_projection(checked_group, exclude_operation_ids=exclude_operation_ids)
        return build_proposal_input(group.to_dict(), revisions, heads, decisions, history, selection, missing_rule_source_refs=missing)

    def _input_for_proposal(self, proposal: Mapping[str, Any]) -> dict[str, Any]:
        own_decisions = [item for item in self._decisions() if item["proposal_id"] == proposal["proposal_id"]]
        own_operations = {item["operation_id"] for item in own_decisions if isinstance(item.get("operation_id"), str)}
        return self._input(
            proposal["group_id"], proposal["model_selection"],
            exclude_decision_proposal_id=proposal["proposal_id"],
            exclude_operation_ids=own_operations,
        )

    def preview(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"group_id", "model_selection"}, "proposal preview")
        built = self._input(data["group_id"], data["model_selection"])
        return {
            "group_id": data["group_id"], "input_signature": built["input_signature"],
            "coverage": built["coverage"], "send_preview": built["payload"], "model_selection": built["model_selection"],
        }, self._cas()

    def generate(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"group_id", "model_selection", "authorization_revision", "explicit_retry"}, "proposal generate")
        if not isinstance(data["explicit_retry"], bool) or type(data["authorization_revision"]) is not int or data["authorization_revision"] < 0:
            raise PreferenceContractError("proposal generation retry or authorization revision is invalid")
        built = self._input(data["group_id"], data["model_selection"])
        input_digest = _digest({"action": "generate", "payload": data, "input_signature": built["input_signature"]})
        prior_request = self._request_result(request_id, input_digest)
        if prior_request is not None:
            return prior_request, self._cas()
        jobs = self._jobs()
        proposals = self._proposals()
        if not data["explicit_retry"]:
            existing_proposal = next((item for item in reversed(proposals) if item["input_signature"] == built["input_signature"]), None)
            if existing_proposal is not None:
                result = {"proposal": existing_proposal, "idempotent": True, "charged": False}
                self._commit({}, request=(request_id, input_digest, result))
                return result, self._cas()
            existing_job = next((item for item in reversed(jobs) if item["input_signature"] == built["input_signature"] and item["state"] != "cancelled"), None)
            if existing_job is not None:
                from .config import PreferenceConfig
                config = PreferenceConfig.load(self.root)
                try:
                    consent = self._consent()
                except PreferenceError:
                    consent = None
                can_queue = (
                    config.enabled and config.stage_enabled("proposals")
                    and consent is not None
                    and self._consent_allows(consent, built, data["authorization_revision"])
                )
                if existing_job["state"] in {"blocked_consent", "blocked_config", "blocked_model", "failed"} and can_queue:
                    existing_job.update({"generation": existing_job["generation"] + 1, "updated_at": utc_now(), "state": "queued", "authorization_revision": data["authorization_revision"], "model_selection": built["model_selection"], "attempts": 0, "next_attempt_at": None, "lease": None, "error_code": None})
                    ProposalJob.from_dict(existing_job)
                    result = {"job": copy.deepcopy(existing_job), "idempotent": False, "charged": False, "requeued": True}
                    self._commit({self.jobs_path: _json_bytes(jobs)}, request=(request_id, input_digest, result))
                    return result, self._cas(jobs=jobs)
                result = {"job": existing_job, "idempotent": True, "charged": existing_job["attempts"] > 0}
                self._commit({}, request=(request_id, input_digest, result))
                return result, self._cas()
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        state = "queued"
        error_code = None
        try:
            consent = self._consent()
        except PreferenceError:
            consent = None
        if not config.enabled or not config.stage_enabled("proposals"):
            state, error_code = "blocked_config", "proposals_disabled"
        elif consent is None or not self._consent_allows(consent, built, data["authorization_revision"]):
            state, error_code = "blocked_consent", "proposal_send_not_authorized"
        now = utc_now()
        job = {
            "schema_version": 1, "job_id": new_id("proposal-job-"), "generation": 0, "request_id": _id(request_id, "request_id"),
            "created_at": now, "updated_at": now, "state": state, "group_id": data["group_id"],
            "model_selection": built["model_selection"], "authorization_revision": data["authorization_revision"],
            "input_signature": built["input_signature"], "input_digest": input_digest, "attempts": 0,
            "next_attempt_at": None, "lease": None, "result_ref": None, "error_code": error_code, "usage": None,
        }
        ProposalJob.from_dict(job)
        jobs.append(job)
        result = {"job": copy.deepcopy(job), "coverage": built["coverage"], "charged": False}
        self._commit({self.jobs_path: _json_bytes(jobs)}, request=(request_id, input_digest, result))
        return result, self._cas(jobs=jobs)

    prepare = generate

    def trigger(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"group_id", "evidence_ref"}, "proposal new-evidence trigger")
        group_id = _id(data["group_id"], "proposal trigger group_id")
        evidence_ref = _ref(data["evidence_ref"], "proposal trigger evidence_ref")
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        if not config.enabled or not config.stage_enabled("proposals") or config.learning["proposal_trigger"] != "new_evidence":
            return {"triggered": False, "pending_authorization": False, "charged": False, "reason": "automatic_proposals_disabled"}, self._cas()
        try:
            consent = self._consent()
        except PreferenceError:
            consent = None
        if consent is None or not consent["allowed"] or consent["scope"] != "new_evidence" or group_id not in consent["group_ids"]:
            return {"triggered": False, "pending_authorization": True, "charged": False, "reason": "future_evidence_scope_required"}, self._cas()
        active = next((row for row in EvidenceStore(self.root).view()["evidence"] if row["evidence_id"] == evidence_ref["evidence_id"]), None)
        revision = active.get("revision") if isinstance(active, dict) else None
        content = revision.get("content") if isinstance(revision, dict) else None
        if (not isinstance(active, dict) or active.get("status") != "active"
                or not isinstance(revision, dict) or revision.get("revision_id") != evidence_ref["revision_id"]
                or revision.get("group_id") != group_id or revision.get("origin_verified") is not True
                or not isinstance(content, dict) or content.get("needs_review") is not False
                or content.get("nature") != "preference"):
            return {"triggered": False, "pending_authorization": False, "charged": False, "reason": "evidence_not_eligible"}, self._cas()
        built = self._input(group_id, consent["model_selection"])
        if not self._consent_allows(consent, built, consent["revision"]):
            return {"triggered": False, "pending_authorization": True, "charged": False, "reason": "future_evidence_scope_changed"}, self._cas()
        result, cas = self.generate(request_id, {
            "group_id": group_id,
            "model_selection": consent["model_selection"],
            "authorization_revision": consent["revision"],
            "explicit_retry": False,
        })
        return {**result, "triggered": True}, cas

    def inspect(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """Read proposal/job state without recovery writes (status-safe)."""
        return {"proposals": self._proposals(), "jobs": self._jobs()}, self._cas()

    def list(self) -> tuple[dict[str, Any], dict[str, Any]]:
        self.reconcile_receipts()
        self.revalidate_all()
        return self.inspect()

    def get(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"proposal_id"}, "proposal get")
        self.reconcile_receipts()
        self.revalidate_all()
        proposal = self._find_proposal(self._proposals(), data["proposal_id"])
        revisions = EvidenceStore(self.root).revisions()[0]
        referenced = {_ref_key(ref) for change in proposal["changes"] for ref in change["evidence_refs"]}
        evidence_details = [copy.deepcopy(revisions[revision_id]) for evidence_id, revision_id in sorted(referenced) if revision_id in revisions and revisions[revision_id]["evidence_id"] == evidence_id]
        confirmations = [item for item in self._delete_confirmations() if item["proposal_id"] == proposal["proposal_id"]]
        return {
            "proposal": proposal,
            "diffs": [self._change_diff(item) for item in proposal["changes"]],
            "evidence_details": evidence_details,
            "delete_opposition_confirmations": confirmations,
        }, self._cas()

    @staticmethod
    def _change_diff(change: Mapping[str, Any]) -> dict[str, Any]:
        before = change["rule_ref"]["text"] if isinstance(change.get("rule_ref"), dict) else None
        after = change.get("proposed_text")
        return {"change_id": change["change_id"], "action": change["action"], "before": before, "after": after}

    def job_list(self) -> tuple[dict[str, Any], dict[str, Any]]:
        jobs = self._jobs()
        return {"jobs": jobs}, self._cas(jobs=jobs)

    @staticmethod
    def _find_job(jobs: list[dict[str, Any]], job_id: Any) -> dict[str, Any]:
        checked = _id(job_id, "job_id")
        for item in jobs:
            if item["job_id"] == checked:
                return item
        raise PreferenceContractError("proposal job does not exist")

    @staticmethod
    def _find_proposal(proposals: list[dict[str, Any]], proposal_id: Any) -> dict[str, Any]:
        checked = _id(proposal_id, "proposal_id")
        for item in proposals:
            if item["proposal_id"] == checked:
                return item
        raise PreferenceContractError("proposal does not exist")

    def _stop_job(self, jobs: list[dict[str, Any]], job: dict[str, Any], state: str, code: str) -> tuple[dict[str, Any], dict[str, Any]]:
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": state, "lease": None, "next_attempt_at": None, "error_code": code})
        ProposalJob.from_dict(job)
        worker = self._worker()
        writes: dict[Path, bytes | None] = {self.jobs_path: _json_bytes(jobs)}
        if isinstance(worker, dict) and worker.get("job_id") == job["job_id"]:
            writes[self.worker_path] = None
        self._commit(writes)
        return {"job": copy.deepcopy(job), "blocked": state.startswith("blocked_")}, self._cas(jobs=jobs)

    def claim(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "owner_id", "authorization_revision", "model_selection", "lease_seconds"}, "proposal job claim")
        jobs = self._jobs()
        job = self._find_job(jobs, data["job_id"])
        selection = _selection(data["model_selection"])
        if job["state"] not in {"queued", "retry_wait"}:
            raise PreferenceContractError("proposal job is not available")
        if job["next_attempt_at"] is not None and _parse_time(job["next_attempt_at"]) > _now():
            raise PreferenceContractError("proposal job is waiting for retry backoff", code="retry_not_due", retryable=True)
        if type(data["lease_seconds"]) is not int or not 5 <= data["lease_seconds"] <= 900:
            raise PreferenceContractError("lease_seconds must be 5..900")
        from .config import PreferenceConfig
        from .jobs import FeedbackJobs
        config = PreferenceConfig.load(self.root)
        if not config.enabled or not config.stage_enabled("proposals"):
            return self._stop_job(jobs, job, "blocked_config", "proposals_disabled")
        if selection != job["model_selection"] or data["authorization_revision"] != job["authorization_revision"]:
            return self._stop_job(jobs, job, "blocked_consent", "frozen_proposal_authorization_changed")
        try:
            consent = self._consent()
        except PreferenceError:
            return self._stop_job(jobs, job, "blocked_consent", "proposal_authorization_missing")
        built = self._input(job["group_id"], selection)
        if not self._consent_allows(consent, built, job["authorization_revision"]) or built["input_signature"] != job["input_signature"]:
            return self._stop_job(jobs, job, "blocked_consent", "proposal_authorization_revoked")
        ready, _message, _endpoint = FeedbackJobs._current_model_status(config, selection, "proposals")
        if not ready:
            return self._stop_job(jobs, job, "blocked_model", "model_unavailable")
        if job["attempts"] >= config.learning["max_attempts"]:
            return self._stop_job(jobs, job, "failed", "max_attempts_exceeded")
        if built["input_signature"] != job["input_signature"]:
            return self._stop_job(jobs, job, "failed", "proposal_input_changed")
        worker = self._worker()
        owner = _id(data["owner_id"], "owner_id")
        if worker is not None and _parse_time(worker["expires_at"]) > _now() and (worker.get("owner_id") != owner or worker.get("job_id") != job["job_id"]):
            raise PreferenceContractError("another learning worker owns this data root", code="worker_busy", retryable=True)
        learning = FeedbackJobs(self.root)._state()
        today = _now().date().isoformat()
        requests = learning["daily_requests"] if learning["daily_date"] == today else 0
        if requests >= config.learning["max_requests_per_day"]:
            return self._stop_job(jobs, job, "blocked_budget", "daily_budget_exhausted")
        job["generation"] += 1
        token = f"lease-{secrets.token_hex(24)}"
        lease = {"token": token, "owner_id": owner, "job_id": job["job_id"], "generation": job["generation"], "expires_at": _iso_after(data["lease_seconds"]), "renewed_at": utc_now()}
        job.update({"state": "running", "attempts": job["attempts"] + 1, "updated_at": utc_now(), "lease": lease, "error_code": None})
        worker_value = {"schema_version": 1, **lease}
        learning.update({"daily_date": today, "daily_requests": requests + 1})
        ProposalJob.from_dict(job)
        state = copy.deepcopy(self._state())
        state["collection_revision"] += 1
        transaction = PersistentTransaction.begin_local(self.root, {
            self.jobs_path: _json_bytes(jobs), self.worker_path: _json_bytes(worker_value),
            self.learning_state_path: _json_bytes(learning), self.state_path: _json_bytes(state),
        })
        try:
            transaction.apply(); transaction.commit_local()
        except Exception:
            transaction.rollback(); raise
        return {"job": copy.deepcopy(job), "prompt": build_proposal_prompt(built), "coverage": built["coverage"]}, self._cas(jobs=jobs)

    def authorize_send(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token", "model_selection", "authorization_revision", "endpoint_fingerprint"}, "proposal send authorization")
        jobs = self._jobs(); job = self._find_job(jobs, data["job_id"]); selection = _selection(data["model_selection"])
        lease = job.get("lease"); worker = self._worker()
        if job["state"] != "running" or not isinstance(lease, dict) or lease.get("token") != data["token"] or _parse_time(lease["expires_at"]) <= _now() or not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("proposal lease is no longer valid")
        from .config import PreferenceConfig
        from .jobs import FeedbackJobs
        config = PreferenceConfig.load(self.root)
        if not config.enabled or not config.stage_enabled("proposals"):
            return self._stop_job(jobs, job, "blocked_config", "proposals_disabled")
        if data["authorization_revision"] != job["authorization_revision"] or selection != job["model_selection"]:
            return self._stop_job(jobs, job, "blocked_consent", "frozen_proposal_authorization_changed")
        try:
            consent = self._consent()
        except PreferenceError:
            return self._stop_job(jobs, job, "blocked_consent", "proposal_authorization_missing")
        built = self._input(job["group_id"], selection)
        if not self._consent_allows(consent, built, job["authorization_revision"]) or built["input_signature"] != job["input_signature"]:
            return self._stop_job(jobs, job, "blocked_consent", "proposal_authorization_revoked")
        ready, _message, current_endpoint = FeedbackJobs._current_model_status(config, selection, "proposals")
        endpoint_matches = data["endpoint_fingerprint"] == selection["endpoint_fingerprint"]
        if config.stage_provider("proposals")["name"] != "pi":
            endpoint_matches = endpoint_matches and current_endpoint == selection["endpoint_fingerprint"]
        if not ready or not endpoint_matches:
            return self._stop_job(jobs, job, "blocked_model", "endpoint_changed")
        if built["input_signature"] != job["input_signature"]:
            return self._stop_job(jobs, job, "failed", "proposal_input_changed")
        return {"job": copy.deepcopy(job), "authorized": True}, self._cas(jobs=jobs)

    def renew(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token", "lease_seconds"}, "proposal job renew")
        jobs = self._jobs(); job = self._find_job(jobs, data["job_id"]); lease = job.get("lease"); worker = self._worker()
        if job["state"] != "running" or not isinstance(lease, dict) or lease.get("token") != data["token"] or _parse_time(lease["expires_at"]) <= _now() or not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("proposal lease is no longer valid")
        if type(data["lease_seconds"]) is not int or not 5 <= data["lease_seconds"] <= 900:
            raise PreferenceContractError("lease_seconds must be 5..900")
        job["generation"] += 1
        lease.update({"generation": job["generation"], "expires_at": _iso_after(data["lease_seconds"]), "renewed_at": utc_now()})
        job["updated_at"] = utc_now()
        worker.update({"generation": job["generation"], "expires_at": lease["expires_at"], "renewed_at": lease["renewed_at"]})
        ProposalJob.from_dict(job)
        self._commit({self.jobs_path: _json_bytes(jobs), self.worker_path: _json_bytes(worker)})
        return {"job": copy.deepcopy(job)}, self._cas(jobs=jobs)

    def _parse_output(self, value: Any, built: Mapping[str, Any]) -> tuple[list[dict[str, Any]], str]:
        if not isinstance(value, str) or len(value.encode("utf-8")) > 512 * 1024:
            raise PreferenceContractError("proposal model response must be a bounded JSON string")
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise PreferenceContractError("proposal model response must be valid JSON") from exc
        data = _strict(parsed, {"changes"}, "proposal model response")
        if not isinstance(data["changes"], list) or not 1 <= len(data["changes"]) <= 3:
            raise PreferenceContractError("proposal model response must contain one to three changes")
        allowed_refs = {_ref_key(item) for item in built["evidence_refs"]}
        rules = {item["rule_id"]: item for item in built["base_rule_refs"]}
        changes: list[dict[str, Any]] = []
        rationale: list[str] = []
        batch_fingerprints: set[str] = set()
        suppressed = {item["fingerprint"] for item in self._decisions() if item["decision"] in {"rejected", "accepted", "accepted_with_edits"}}
        suppressed.update(fingerprint for item in load_operation_records(self.root) for fingerprint in item["decision_fingerprints"])
        for raw in data["changes"]:
            item = _strict(raw, {"action", "rule_id", "expected_text", "proposed_text", "evidence_refs", "opposing_evidence_refs", "rationale", "applicability", "uncertainty", "old_rule_problem"}, "proposal model change")
            action = item["action"]
            if action not in {"add", "replace", "delete", "noop"}:
                raise PreferenceContractError("proposal model action is unsupported")
            for key in ("rationale", "applicability"):
                if not isinstance(item[key], str) or not item[key].strip() or len(item[key]) > 4000:
                    raise PreferenceContractError(f"proposal model {key} is invalid")
                item[key] = sanitize_text(item[key]).text
            for key in ("uncertainty", "old_rule_problem"):
                if item[key] is not None:
                    if not isinstance(item[key], str) or not item[key].strip() or len(item[key]) > 4000:
                        raise PreferenceContractError(f"proposal model {key} is invalid")
                    item[key] = sanitize_text(item[key]).text
            refs = [_ref(ref) for ref in item["evidence_refs"]] if isinstance(item["evidence_refs"], list) else None
            opposing = [_ref(ref) for ref in item["opposing_evidence_refs"]] if isinstance(item["opposing_evidence_refs"], list) else None
            if refs is None or opposing is None or any(_ref_key(ref) not in allowed_refs for ref in [*refs, *opposing]):
                raise PreferenceContractError("proposal model cited unavailable evidence")
            if len({_ref_key(ref) for ref in refs}) != len(refs) or len({_ref_key(ref) for ref in opposing}) != len(opposing) or not {_ref_key(ref) for ref in opposing} <= {_ref_key(ref) for ref in refs}:
                raise PreferenceContractError("proposal model evidence references are duplicated or inconsistent")
            rule_ref = None
            if action in {"replace", "delete"}:
                if not isinstance(item["rule_id"], str) or item["rule_id"] not in rules or item["expected_text"] != rules[item["rule_id"]]["text"]:
                    raise PreferenceContractError("proposal model rule reference is not the exact current rule")
                rule_ref = copy.deepcopy(rules[item["rule_id"]])
                if not isinstance(item["old_rule_problem"], str):
                    raise PreferenceContractError("replace/delete must explain the old rule problem")
            elif item["rule_id"] is not None or item["expected_text"] is not None or item["old_rule_problem"] is not None:
                raise PreferenceContractError("add/noop cannot cite an existing rule or old-rule problem")
            proposed = item["proposed_text"]
            if action in {"add", "replace"}:
                if not isinstance(proposed, str) or not proposed.strip() or len(proposed) > 1000:
                    raise PreferenceContractError("add/replace proposed_text is invalid")
                proposed = sanitize_text(proposed).text
            elif proposed is not None:
                raise PreferenceContractError("delete/noop proposed_text must be null")
            if action == "add" and any(rule["text"] == proposed for rule in rules.values()):
                raise PreferenceContractError("proposal add duplicates an existing rule")
            if action == "replace" and rule_ref is not None and proposed == rule_ref["text"]:
                raise PreferenceContractError("proposal replacement does not change the rule")
            if action == "noop" and (refs or opposing):
                # A noop may discuss supplied evidence but cannot present it as a
                # Gate-qualified support set.
                refs = []
                opposing = []
            change_id = new_id("change-")
            gate = self._gate(action, refs, opposing, built, confirmed_opposition_tasks=set())
            fingerprint = candidate_fingerprint(
                built["payload"]["group"]["id"], action, rule_ref, proposed, refs, opposing,
            )
            if fingerprint in batch_fingerprints:
                raise PreferenceContractError("proposal model returned duplicate candidate changes")
            batch_fingerprints.add(fingerprint)
            if fingerprint in suppressed:
                gate["classification"] = "invalid"
                gate["reasons"] = list(dict.fromkeys([*gate["reasons"], "duplicate_prior_decision"]))
            state = "pending_review" if gate["classification"] == "eligible_for_review" else "blocked"
            change = {
                "change_id": change_id, "action": action, "state": state, "rule_ref": rule_ref,
                "proposed_text": proposed, "evidence_refs": refs, "opposing_evidence_refs": opposing,
                "rationale": item["rationale"], "applicability": item["applicability"],
                "uncertainty": item["uncertainty"], "old_rule_problem": item["old_rule_problem"],
                "gate_result": gate, "review": None,
            }
            Change.from_dict(change)
            changes.append(change)
            rationale.append(item["rationale"])
        return changes, "\n".join(rationale)

    def _gate(
        self,
        action: str,
        refs: list[dict[str, str]],
        opposing: list[dict[str, str]],
        built: Mapping[str, Any],
        *,
        confirmed_opposition_tasks: set[str],
    ) -> dict[str, Any]:
        by_ref = {_ref_key(item): item for item in built["payload"]["effective_evidence"]}
        reasons: list[str] = []
        strong: dict[tuple[str, str], Mapping[str, Any]] = {}
        for ref in refs:
            evidence = by_ref.get(_ref_key(ref))
            if evidence is None:
                reasons.append("invalid_evidence_reference")
                continue
            content = evidence.get("content") if isinstance(evidence.get("content"), dict) else {}
            raw = str(content.get("raw_feedback", ""))
            signal, separator, reason = raw.partition(":")
            has_reason = bool(separator and reason.strip()) or signal.strip() not in {"good", "fix"}
            if evidence.get("origin_verified") is True and content.get("nature") == "preference" and content.get("specificity") == "specific" and content.get("needs_review") is False and has_reason and isinstance(content.get("expected_behavior"), str) and content["expected_behavior"].strip():
                strong[_ref_key(ref)] = evidence
            else:
                reasons.append(f"weak_or_unverified:{ref['evidence_id']}:{ref['revision_id']}")
        support_tasks = {str(item["origin_task_key"]) for key, item in strong.items() if key not in {_ref_key(ref) for ref in opposing}}
        opposition_tasks = {str(strong[key]["origin_task_key"]) for key in {_ref_key(ref) for ref in opposing} if key in strong}
        explicit_opposition = len(opposition_tasks & confirmed_opposition_tasks)
        if built["coverage"]["status"] != "complete":
            reasons.append("coverage_partial")
        if action == "add":
            if len(support_tasks) < 2:
                reasons.append("add_requires_two_independent_tasks")
            if opposition_tasks:
                reasons.append("unresolved_opposing_evidence")
        if action == "replace":
            if len(support_tasks) < 2:
                reasons.append("replace_requires_two_independent_tasks")
            if opposition_tasks:
                reasons.append("unresolved_opposing_evidence")
        if action == "delete":
            if len(opposition_tasks) < 3:
                reasons.append("delete_requires_three_independent_opposing_tasks")
            if explicit_opposition < 2:
                reasons.append("delete_requires_two_user_confirmed_oppositions")
        if action == "noop":
            reasons.append("noop_does_not_change_formal_rules")
        if any(reason.startswith("invalid_evidence") for reason in reasons):
            classification = "invalid"
        elif "unresolved_opposing_evidence" in reasons:
            classification = "needs_review"
        elif action == "noop" or any("requires_" in reason or reason.startswith("weak_or_unverified") or reason == "coverage_partial" for reason in reasons):
            classification = "insufficient_evidence"
        else:
            classification = "eligible_for_review"
        return {
            "classification": classification,
            "reasons": reasons,
            "support_task_count": len(support_tasks),
            "opposition_task_count": len(opposition_tasks),
            "explicit_opposition_count": explicit_opposition,
            "evidence_fingerprint": _digest(sorted((_ref_key(item) for item in refs))),
        }

    def _confirmed_opposition_tasks(
        self,
        proposal: Mapping[str, Any],
        change: Mapping[str, Any],
        built: Mapping[str, Any],
        confirmations: Iterable[Mapping[str, Any]] | None = None,
    ) -> set[str]:
        if change["action"] != "delete" or not isinstance(change.get("rule_ref"), dict):
            return set()
        available = {_ref_key(item): item for item in built["payload"]["effective_evidence"]}
        opposing = {_ref_key(item) for item in change["opposing_evidence_refs"]}
        tasks: set[str] = set()
        for confirmation in self._delete_confirmations() if confirmations is None else confirmations:
            if confirmation["proposal_id"] != proposal["proposal_id"] or confirmation["change_id"] != change["change_id"]:
                continue
            if confirmation["group_id"] != proposal["group_id"] or confirmation["rule_ref"] != change["rule_ref"]:
                continue
            ref_key = _ref_key(confirmation["evidence_ref"])
            evidence = available.get(ref_key)
            if ref_key not in opposing or evidence is None or evidence.get("origin_task_key") != confirmation["origin_task_key"]:
                continue
            tasks.add(str(confirmation["origin_task_key"]))
        return tasks

    def _gate_for_change(
        self,
        proposal: Mapping[str, Any],
        change: Mapping[str, Any],
        built: Mapping[str, Any],
        confirmations: Iterable[Mapping[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return self._gate(
            change["action"], change["evidence_refs"], change["opposing_evidence_refs"], built,
            confirmed_opposition_tasks=self._confirmed_opposition_tasks(proposal, change, built, confirmations),
        )

    def complete(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        required = {"job_id", "token", "input_digest", "input_signature", "model_selection", "authorization_revision", "output"}
        if not isinstance(payload, dict) or set(payload) not in {frozenset(required), frozenset({*required, "usage"})}:
            raise PreferenceContractError("proposal completion has an invalid schema")
        data = dict(payload)
        jobs = self._jobs(); job = self._find_job(jobs, data["job_id"]); selection = _selection(data["model_selection"])
        usage = model_usage(data["usage"], selection) if "usage" in data else {
            "known": False, "input_tokens": None, "output_tokens": None, "total_tokens": None,
            "cost_usd": None, "cost_status": "unknown", "provider_id": selection["provider_id"],
            "model_id": selection["model_id"], "max_tokens": selection["max_tokens"],
        }
        lease = job.get("lease"); worker = self._worker()
        if job["state"] != "running" or not isinstance(lease, dict) or lease.get("token") != data["token"] or _parse_time(lease["expires_at"]) <= _now() or not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"] or data["input_digest"] != job["input_digest"] or data["input_signature"] != job["input_signature"] or data["authorization_revision"] != job["authorization_revision"] or selection != job["model_selection"]:
            raise PreferenceContractError("proposal result does not match its active lease and frozen input")
        authorized, _ = self.authorize_send({"job_id": job["job_id"], "token": data["token"], "model_selection": selection, "authorization_revision": job["authorization_revision"], "endpoint_fingerprint": selection["endpoint_fingerprint"]})
        if authorized.get("blocked"):
            return authorized, self._cas()
        built = self._input(job["group_id"], selection)
        if built["input_signature"] != job["input_signature"]:
            return self._stop_job(jobs, job, "failed", "proposal_input_changed")
        changes, rationale = self._parse_output(data["output"], built)
        now = utc_now()
        proposal_id = new_id("proposal-")
        proposal = {
            "schema_version": 1, "proposal_id": proposal_id, "generation": 0, "created_at": now, "updated_at": now,
            "job_id": job["job_id"], "model_selection": selection, "prompt_version": PROMPT_VERSION, "gate_version": GATE_VERSION,
            "input_signature": built["input_signature"], "group_id": job["group_id"], "base_group_digest": built["base_group_digest"],
            "base_group_revision": built["base_group_revision"], "base_rule_refs": built["base_rule_refs"], "evidence_refs": built["evidence_refs"],
            "evidence_heads": built["evidence_heads"], "evidence_view_digest": built["evidence_view_digest"], "decision_digest": built["decision_digest"],
            "coverage": built["coverage"], "changes": changes, "rationale": rationale, "state": _proposal_state(changes),
        }
        Proposal.from_dict(proposal)
        proposals = self._proposals(); proposals.append(proposal)
        job.update({"generation": job["generation"] + 1, "updated_at": now, "state": "completed", "lease": None, "next_attempt_at": None, "result_ref": proposal_id, "error_code": None, "usage": usage})
        ProposalJob.from_dict(job)
        self._commit({self.proposals_path: _json_bytes(proposals), self.jobs_path: _json_bytes(jobs), self.worker_path: None})
        return {"job": copy.deepcopy(job), "proposal": copy.deepcopy(proposal)}, self._cas(proposals, jobs)

    def fail(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token", "code"}, "proposal job fail")
        jobs = self._jobs(); job = self._find_job(jobs, data["job_id"]); worker = self._worker()
        if job["state"] != "running" or not isinstance(job.get("lease"), dict) or job["lease"].get("token") != data["token"] or not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("proposal lease is no longer valid")
        from .config import PreferenceConfig
        retry = job["attempts"] < PreferenceConfig.load(self.root).learning["max_attempts"]
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "retry_wait" if retry else "failed", "next_attempt_at": _iso_after(30) if retry else None, "lease": None, "error_code": _id(data["code"], "code")})
        ProposalJob.from_dict(job)
        self._commit({self.jobs_path: _json_bytes(jobs), self.worker_path: None})
        return {"job": copy.deepcopy(job)}, self._cas(jobs=jobs)

    def cancel_lease(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token"}, "proposal job cancel")
        jobs = self._jobs(); job = self._find_job(jobs, data["job_id"]); worker = self._worker()
        if job["state"] != "running" or not isinstance(job.get("lease"), dict) or job["lease"].get("token") != data["token"] or not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("proposal lease is no longer valid")
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "cancelled", "lease": None, "next_attempt_at": None, "error_code": "cancelled"})
        ProposalJob.from_dict(job)
        self._commit({self.jobs_path: _json_bytes(jobs), self.worker_path: None})
        return {"job": copy.deepcopy(job)}, self._cas(jobs=jobs)

    def cancel(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation"}, "proposal cancel")
        jobs = self._jobs(); job = self._find_job(jobs, data["job_id"])
        if job["state"] == "cancelled":
            return {"job": copy.deepcopy(job), "idempotent": True}, self._cas(jobs=jobs)
        if data["generation"] != job["generation"]:
            raise PreferenceConflictError("proposal job generation changed")
        if job["state"] == "completed":
            raise PreferenceContractError("completed proposal job cannot be cancelled")
        worker = self._worker()
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "cancelled", "lease": None, "next_attempt_at": None, "error_code": "cancelled"})
        writes: dict[Path, bytes | None] = {self.jobs_path: _json_bytes(jobs)}
        if isinstance(worker, dict) and worker.get("job_id") == job["job_id"]:
            writes[self.worker_path] = None
        self._commit(writes)
        return {"job": copy.deepcopy(job)}, self._cas(jobs=jobs)

    def sweep(self) -> tuple[dict[str, Any], dict[str, Any]]:
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        jobs = self._jobs(); changed = 0; now = _now()
        for job in jobs:
            lease = job.get("lease")
            if job["state"] == "running" and isinstance(lease, dict) and _parse_time(lease["expires_at"]) <= now:
                retry = job["attempts"] < config.learning["max_attempts"]
                job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "retry_wait" if retry else "failed", "lease": None, "next_attempt_at": _iso_after(30) if retry else None, "error_code": "lease_expired"})
                changed += 1
        worker = self._worker(); writes: dict[Path, bytes | None] = {}
        if changed:
            writes[self.jobs_path] = _json_bytes(jobs)
        if worker is not None and _parse_time(worker["expires_at"]) <= now:
            writes[self.worker_path] = None; changed += 1
        if writes:
            self._commit(writes)
        return {"recovered": changed, "jobs": jobs}, self._cas(jobs=jobs)

    def reject_dispatch(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation", "input_digest", "input_signature", "model_selection", "authorization_revision", "claim_error_code"}, "proposal dispatch rejection")
        if data["claim_error_code"] not in _PERMANENT_DISPATCH_ERRORS:
            raise PreferenceContractError("claim error is not eligible for durable rejection")
        jobs = self._jobs(); job = self._find_job(jobs, data["job_id"])
        if job["state"] not in {"queued", "retry_wait"} or data["generation"] != job["generation"] or data["input_digest"] != job["input_digest"] or data["input_signature"] != job["input_signature"] or _selection(data["model_selection"]) != job["model_selection"] or data["authorization_revision"] != job["authorization_revision"]:
            raise PreferenceConflictError("proposal job changed before dispatch rejection")
        return self._stop_job(jobs, job, "failed", _PERMANENT_DISPATCH_ERRORS[data["claim_error_code"]])

    def _mark_stale(self, proposal: dict[str, Any], reason: str) -> bool:
        changed = False
        for item in proposal["changes"]:
            if item["state"] in {"pending_review", "deferred"}:
                item["state"] = "stale"
                item["gate_result"]["reasons"] = list(dict.fromkeys([*item["gate_result"]["reasons"], reason]))
                changed = True
        if changed:
            proposal.update({"generation": proposal["generation"] + 1, "updated_at": utc_now(), "state": _proposal_state(proposal["changes"])})
            Proposal.from_dict(proposal)
        return changed

    def revalidate(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"proposal_id", "generation"}, "proposal revalidate")
        proposals = self._proposals(); proposal = self._find_proposal(proposals, data["proposal_id"])
        if data["generation"] != proposal["generation"]:
            raise PreferenceConflictError("proposal generation changed")
        built = self._input_for_proposal(proposal)
        valid = built["input_signature"] == proposal["input_signature"] and built["base_group_digest"] == proposal["base_group_digest"] and built["evidence_view_digest"] == proposal["evidence_view_digest"]
        if not valid and self._mark_stale(proposal, "proposal_input_changed"):
            self._commit({self.proposals_path: _json_bytes(proposals)})
        return {"proposal": copy.deepcopy(proposal), "valid": valid, "current_input_signature": built["input_signature"], "current_coverage": built["coverage"]}, self._cas(proposals=proposals)

    def revalidate_all(self) -> dict[str, Any]:
        proposals = self._proposals(); stale: list[str] = []
        for proposal in proposals:
            if proposal["state"] not in {"pending_review", "deferred"}:
                continue
            try:
                built = self._input_for_proposal(proposal)
                valid = built["input_signature"] == proposal["input_signature"]
            except PreferenceError:
                valid = False
            if not valid and self._mark_stale(proposal, "proposal_input_changed"):
                stale.append(proposal["proposal_id"])
        if stale:
            self._commit({self.proposals_path: _json_bytes(proposals)})
        return {"stale_proposal_ids": stale}

    def _decision(
        self,
        proposal: Mapping[str, Any],
        change: Mapping[str, Any],
        decision: str,
        reason: str | None,
        *,
        operation_id: str | None = None,
    ) -> dict[str, Any]:
        return {
            "decision_id": new_id("decision-"), "proposal_id": proposal["proposal_id"], "change_id": change["change_id"],
            "decision": decision, "decided_at": utc_now(), "reason": reason,
            "fingerprint": _change_fingerprint(proposal, change),
            "operation_id": operation_id,
        }

    def confirm_delete_opposition(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"proposal_id", "generation", "change_id", "rule_ref", "evidence_ref"}, "delete opposition confirmation")
        input_digest = _digest({"action": "confirm-delete-opposition", "payload": data})
        previous = self._request_result(request_id, input_digest)
        if previous is not None:
            return previous, self._cas()
        proposals = self._proposals(); proposal = self._find_proposal(proposals, data["proposal_id"])
        if data["generation"] != proposal["generation"]:
            raise PreferenceConflictError("proposal generation changed")
        change = self._selected_changes(proposal, [data["change_id"]])[0]
        if change["action"] != "delete" or change["state"] not in {"blocked", "pending_review", "deferred"}:
            raise PreferenceContractError("only a reviewable delete change accepts opposition confirmation")
        if data["rule_ref"] != change["rule_ref"]:
            raise PreferenceConflictError("delete confirmation rule revision or digest changed")
        evidence_ref = _ref(data["evidence_ref"], "delete confirmation evidence_ref")
        if _ref_key(evidence_ref) not in {_ref_key(item) for item in change["opposing_evidence_refs"]}:
            raise PreferenceContractError("delete confirmation evidence is not a cited opposing revision")
        built = self._input_for_proposal(proposal)
        if built["input_signature"] != proposal["input_signature"] or built["base_group_digest"] != proposal["base_group_digest"] or built["evidence_heads"] != proposal["evidence_heads"]:
            if self._mark_stale(proposal, "proposal_input_changed"):
                self._commit({self.proposals_path: _json_bytes(proposals)})
            raise PreferenceConflictError("delete confirmation inputs changed")
        evidence = next((item for item in built["payload"]["effective_evidence"] if _ref_key(item) == _ref_key(evidence_ref)), None)
        if evidence is None:
            raise PreferenceConflictError("delete confirmation evidence revision is no longer current")
        confirmations = self._delete_confirmations()
        existing = next((item for item in confirmations if item["proposal_id"] == proposal["proposal_id"] and item["change_id"] == change["change_id"] and item["evidence_ref"] == evidence_ref and item["rule_ref"] == change["rule_ref"]), None)
        if existing is not None:
            result = {"proposal": copy.deepcopy(proposal), "confirmed_task_count": change["gate_result"]["explicit_opposition_count"], "idempotent": True}
            self._commit({}, request=(request_id, input_digest, result))
            return result, self._cas(proposals=proposals)
        confirmation = {
            "confirmation_id": new_id("delete-confirmation-"), "proposal_id": proposal["proposal_id"],
            "change_id": change["change_id"], "group_id": proposal["group_id"],
            "rule_ref": copy.deepcopy(change["rule_ref"]), "evidence_ref": evidence_ref,
            "origin_task_key": evidence["origin_task_key"], "confirmed_at": utc_now(),
        }
        confirmations.append(confirmation)
        gate = self._gate_for_change(proposal, change, built, confirmations)
        change["gate_result"] = gate
        if change["state"] != "deferred":
            change["state"] = "pending_review" if gate["classification"] == "eligible_for_review" else "blocked"
        proposal.update({"generation": proposal["generation"] + 1, "updated_at": utc_now(), "state": _proposal_state(proposal["changes"])})
        result = {"proposal": copy.deepcopy(proposal), "confirmed_task_count": gate["explicit_opposition_count"], "idempotent": False}
        self._commit({self.proposals_path: _json_bytes(proposals), self.delete_confirmations_path: _json_bytes(confirmations)}, request=(request_id, input_digest, result))
        return result, self._cas(proposals=proposals)

    def resume(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"proposal_id", "generation", "change_ids"}, "proposal resume")
        input_digest = _digest({"action": "resume", "payload": data})
        previous = self._request_result(request_id, input_digest)
        if previous is not None:
            return previous, self._cas()
        proposals = self._proposals(); proposal = self._find_proposal(proposals, data["proposal_id"])
        if data["generation"] != proposal["generation"]:
            raise PreferenceConflictError("proposal generation changed")
        built = self._input_for_proposal(proposal)
        if built["input_signature"] != proposal["input_signature"] or built["base_group_digest"] != proposal["base_group_digest"] or built["evidence_heads"] != proposal["evidence_heads"]:
            if self._mark_stale(proposal, "proposal_input_changed"):
                self._commit({self.proposals_path: _json_bytes(proposals)})
            raise PreferenceConflictError("deferred proposal inputs changed")
        selected = self._selected_changes(proposal, data["change_ids"])
        for change in selected:
            if change["state"] != "deferred":
                raise PreferenceContractError("only deferred proposal changes can resume review")
            gate = self._gate_for_change(proposal, change, built)
            change.update({"gate_result": gate, "state": "pending_review" if gate["classification"] == "eligible_for_review" else "blocked", "review": None})
        proposal.update({"generation": proposal["generation"] + 1, "updated_at": utc_now(), "state": _proposal_state(proposal["changes"])})
        result = {"proposal": copy.deepcopy(proposal)}
        self._commit({self.proposals_path: _json_bytes(proposals)}, request=(request_id, input_digest, result))
        return result, self._cas(proposals=proposals)

    def defer(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"proposal_id", "generation", "change_ids"}, "proposal defer")
        input_digest = _digest({"action": "defer", "payload": data})
        previous = self._request_result(request_id, input_digest)
        if previous is not None:
            return previous, self._cas()
        proposals = self._proposals(); proposal = self._find_proposal(proposals, data["proposal_id"])
        if data["generation"] != proposal["generation"]:
            raise PreferenceConflictError("proposal generation changed")
        selected = self._selected_changes(proposal, data["change_ids"])
        decisions = self._decisions()
        for change in selected:
            if change["state"] != "pending_review":
                raise PreferenceContractError("only pending proposal changes can be deferred")
            decision = self._decision(proposal, change, "deferred", None); decisions.append(decision)
            change.update({"state": "deferred", "review": {"decision": "deferred", "decided_at": decision["decided_at"], "final_text": None, "reason": None, "operation_id": None}})
        proposal.update({"generation": proposal["generation"] + 1, "updated_at": utc_now(), "state": _proposal_state(proposal["changes"])})
        result = {"proposal": copy.deepcopy(proposal)}
        self._commit({self.proposals_path: _json_bytes(proposals), self.decisions_path: _json_bytes(decisions)}, request=(request_id, input_digest, result))
        return result, self._cas(proposals=proposals)

    def reject(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"proposal_id", "generation", "change_ids", "reason"}, "proposal reject")
        if not isinstance(data["reason"], str) or not data["reason"].strip() or len(data["reason"]) > 2000:
            raise PreferenceContractError("proposal rejection reason is required and bounded")
        reason = sanitize_text(data["reason"]).text
        input_digest = _digest({"action": "reject", "payload": {**data, "reason": reason}})
        previous = self._request_result(request_id, input_digest)
        if previous is not None:
            return previous, self._cas()
        proposals = self._proposals(); proposal = self._find_proposal(proposals, data["proposal_id"])
        if data["generation"] != proposal["generation"]:
            raise PreferenceConflictError("proposal generation changed")
        selected = self._selected_changes(proposal, data["change_ids"])
        operation_id = new_id("operation-")
        decisions = self._decisions(); fingerprints: list[str] = []
        for change in selected:
            if change["state"] not in {"pending_review", "blocked", "deferred"}:
                raise PreferenceContractError("proposal change is not rejectable")
            decision = self._decision(proposal, change, "rejected", reason, operation_id=operation_id); decisions.append(decision); fingerprints.append(decision["fingerprint"])
            change.update({"state": "rejected", "review": {"decision": "rejected", "decided_at": decision["decided_at"], "final_text": None, "reason": reason, "operation_id": operation_id}})
        proposal.update({"generation": proposal["generation"] + 1, "updated_at": utc_now(), "state": _proposal_state(proposal["changes"])})
        from .git_sync import begin_generated_transaction, commit_generated, complete_generated_transaction, restore_generated_transaction
        from .store import PreferenceStore, atomic_write_text
        store = PreferenceStore(self.root); groups = groups_document_v2(store.read_groups_v2())
        transaction = begin_generated_transaction(store.repo, extra_paths=(self.proposals_path, self.decisions_path, self.state_path), data_root=self.root)
        record = operation_record(
            operation_id=operation_id,
            transaction_id=generated_transaction_id(transaction),
            kind="proposal_reject",
            source_kind="proposal_reject",
            before_groups=groups,
            after_groups=groups,
            effects=[],
            decision_fingerprints=fingerprints,
        )
        try:
            atomic_write_text(self.proposals_path, stable_json_dumps(proposals) + "\n")
            atomic_write_text(self.decisions_path, stable_json_dumps(decisions) + "\n")
            state = copy.deepcopy(self._state()); state["collection_revision"] += 1; state["requests"][_id(request_id, "request_id")] = {"input_digest": input_digest, "data": {"proposal": copy.deepcopy(proposal), "operation_id": operation_id}}
            while len(state["requests"]) > _MAX_REQUEST_RECORDS: state["requests"].pop(next(iter(state["requests"])))
            atomic_write_text(self.state_path, stable_json_dumps(state) + "\n")
            write_operation_path(self.root, record)
            commit = commit_generated(store.repo, "personal-preferences: proposal reject")
            if not commit:
                raise PreferenceGitError("proposal rejection did not create a history commit")
            complete_generated_transaction(transaction)
        except Exception:
            restore_generated_transaction(transaction); raise
        return {"proposal": copy.deepcopy(proposal), "operation_id": operation_id, "commit": commit}, self._cas(proposals=proposals)

    @staticmethod
    def _selected_changes(proposal: Mapping[str, Any], change_ids: Any) -> list[dict[str, Any]]:
        if not isinstance(change_ids, list) or not change_ids or any(not isinstance(item, str) for item in change_ids):
            raise PreferenceContractError("change_ids must be a non-empty list")
        if len(change_ids) != len(set(change_ids)):
            raise PreferenceContractError("change_ids must not contain duplicates")
        by_id = {item["change_id"]: item for item in proposal["changes"]}
        if any(item not in by_id for item in change_ids):
            raise PreferenceContractError("change_id does not belong to proposal")
        return [by_id[item] for item in change_ids]

    @staticmethod
    def _validate_receipt_operation(operation: Mapping[str, Any], proposal: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
        if operation["proposal_id"] != proposal["proposal_id"]:
            raise PreferenceIntegrityError("proposal receipt operation ownership does not match")
        changes = {item["change_id"]: item for item in proposal["changes"]}
        if any(change_id not in changes for change_id in operation["change_ids"]):
            raise PreferenceIntegrityError("proposal receipt operation references an unknown change")
        expected_fingerprints = {_change_fingerprint(proposal, changes[change_id]) for change_id in operation["change_ids"]}
        if set(operation["decision_fingerprints"]) != expected_fingerprints:
            raise PreferenceIntegrityError("proposal receipt candidate fingerprints do not match local candidates")
        effects = {item["change_id"]: item for item in operation["effects"] if isinstance(item.get("change_id"), str)}
        if set(effects) != set(operation["change_ids"]):
            raise PreferenceIntegrityError("proposal receipt operation effects do not map one-to-one to changes")
        for change_id, effect in effects.items():
            change = changes[change_id]
            if effect["proposal_id"] != proposal["proposal_id"] or effect["group_id"] != proposal["group_id"] or effect["action"] != change["action"]:
                raise PreferenceIntegrityError("proposal receipt effect action, group, or proposal does not match")
            if _canonical_refs(effect["evidence_refs"]) != _canonical_refs(change["evidence_refs"]):
                raise PreferenceIntegrityError("proposal receipt effect evidence does not match candidate")
            before_rule = effect["before_rule"]
            after_rule = effect["after_rule"]
            if change["action"] == "add":
                if before_rule is not None or not isinstance(after_rule, dict):
                    raise PreferenceIntegrityError("proposal add receipt has an invalid rule diff")
                if effect["decision"] == "accepted" and after_rule.get("text") != change["proposed_text"]:
                    raise PreferenceIntegrityError("proposal add receipt changed text without edited acceptance")
            elif change["action"] in {"replace", "delete"}:
                rule_ref = change["rule_ref"]
                if not isinstance(before_rule, dict) or before_rule.get("id") != rule_ref["rule_id"] or before_rule.get("revision") != rule_ref["revision"] or before_rule.get("text") != rule_ref["text"] or _digest(before_rule) != rule_ref["digest"]:
                    raise PreferenceIntegrityError("proposal receipt before rule does not match exact candidate rule")
                if change["action"] == "replace":
                    if not isinstance(after_rule, dict) or after_rule.get("id") != before_rule["id"] or after_rule.get("revision") != before_rule["revision"] + 1:
                        raise PreferenceIntegrityError("proposal replace receipt has an invalid after rule")
                    if effect["decision"] == "accepted" and after_rule.get("text") != change["proposed_text"]:
                        raise PreferenceIntegrityError("proposal replace receipt changed text without edited acceptance")
                elif after_rule is not None:
                    raise PreferenceIntegrityError("proposal delete receipt retained an after rule")
            else:
                raise PreferenceIntegrityError("formal proposal receipt cannot apply noop")
        return effects

    def _operation_receipt_details(self) -> dict[tuple[str, str], tuple[str, dict[str, Any] | None]]:
        result: dict[tuple[str, str], tuple[str, dict[str, Any] | None]] = {}
        proposals = {item["proposal_id"]: item for item in self._proposals()}
        for operation in load_operation_records(self.root):
            if operation["kind"] != "proposal_apply" or not isinstance(operation["proposal_id"], str):
                continue
            proposal = proposals.get(operation["proposal_id"])
            if proposal is None:
                continue
            effects = self._validate_receipt_operation(operation, proposal)
            for change_id in operation["change_ids"]:
                key = (operation["proposal_id"], change_id)
                if key in result:
                    raise PreferenceIntegrityError("multiple operations claim the same proposal change receipt")
                result[key] = (operation["operation_id"], effects[change_id])
        return result

    def _operation_receipts(self) -> dict[tuple[str, str], str]:
        return {key: value[0] for key, value in self._operation_receipt_details().items()}

    def reconcile_receipts(self) -> dict[str, Any]:
        receipt_details = self._operation_receipt_details(); receipts_by_key = {key: value[0] for key, value in receipt_details.items()}; proposals = self._proposals(); receipts = self._receipts(); changed = False
        known = {(item.get("proposal_id"), item.get("change_id")) for item in receipts if isinstance(item, dict)}
        for proposal in proposals:
            for change in proposal["changes"]:
                operation_id = receipts_by_key.get((proposal["proposal_id"], change["change_id"]))
                if operation_id is None:
                    continue
                if (proposal["proposal_id"], change["change_id"]) not in known:
                    receipts.append({"proposal_id": proposal["proposal_id"], "change_id": change["change_id"], "operation_id": operation_id, "recovered_at": utc_now()}); known.add((proposal["proposal_id"], change["change_id"])); changed = True
                if change["state"] != "applied":
                    effect = receipt_details[(proposal["proposal_id"], change["change_id"])][1] or {}
                    decision = effect.get("decision") if effect.get("decision") in {"accepted", "accepted_with_edits"} else "accepted"
                    after_rule = effect.get("after_rule") if isinstance(effect.get("after_rule"), dict) else None
                    final_text = after_rule.get("text") if after_rule is not None else change.get("proposed_text")
                    change.update({"state": "applied", "review": {"decision": decision, "decided_at": utc_now(), "final_text": final_text, "reason": None, "operation_id": operation_id}}); changed = True
            derived = _proposal_state(proposal["changes"])
            if proposal["state"] != derived:
                proposal["state"] = derived; proposal["generation"] += 1; proposal["updated_at"] = utc_now(); changed = True
        if changed:
            self._commit({self.proposals_path: _json_bytes(proposals), self.receipts_path: _json_bytes(receipts)})
        return {"recovered_receipts": len(receipts_by_key)}

    def accept(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"proposal_id", "generation", "input_signature", "change_ids", "edited_texts"}, "proposal accept")
        if not isinstance(data["edited_texts"], Mapping) or isinstance(data["edited_texts"], list) or any(not isinstance(key, str) or not isinstance(value, str) or not value.strip() or len(value) > 1000 for key, value in data["edited_texts"].items()):
            raise PreferenceContractError("edited_texts must map selected change IDs to bounded text")
        self.reconcile_receipts()
        receipts_by_key = self._operation_receipts(); proposals = self._proposals(); proposal = self._find_proposal(proposals, data["proposal_id"])
        selected = self._selected_changes(proposal, data["change_ids"])
        existing = [receipts_by_key.get((proposal["proposal_id"], item["change_id"])) for item in selected]
        if all(existing):
            return {"proposal": proposal, "operation_id": existing[0], "idempotent": True}, self._cas(proposals=proposals)
        if any(existing):
            raise PreferenceConflictError("selected proposal changes were only partially applied")
        if data["generation"] != proposal["generation"] or data["input_signature"] != proposal["input_signature"]:
            raise PreferenceConflictError("proposal generation or input signature changed")
        if set(data["edited_texts"]) - {item["change_id"] for item in selected}:
            raise PreferenceContractError("edited_texts contains an unselected change")
        built = self._input_for_proposal(proposal)
        if built["input_signature"] != proposal["input_signature"] or built["base_group_digest"] != proposal["base_group_digest"] or built["evidence_heads"] != proposal["evidence_heads"] or built["evidence_view_digest"] != proposal["evidence_view_digest"]:
            if self._mark_stale(proposal, "proposal_input_changed"):
                self._commit({self.proposals_path: _json_bytes(proposals)})
            raise PreferenceConflictError("proposal inputs changed; review the refreshed diff before accepting")
        if proposal["coverage"]["status"] != "complete":
            raise PreferenceContractError("partial-coverage proposals cannot be accepted; use explicit remember for a user-authored rule")
        for item in selected:
            current_gate = self._gate_for_change(proposal, item, built)
            item["gate_result"] = current_gate
            if item["state"] != "pending_review" or current_gate["classification"] != "eligible_for_review":
                raise PreferenceContractError("only currently Gate-eligible pending changes can be accepted")
        from .store import PreferenceStore, atomic_write_text
        from .git_sync import begin_generated_transaction, commit_generated, complete_generated_transaction, restore_generated_transaction
        store = PreferenceStore(self.root); groups = store.read_groups_v2(); before_doc = groups_document_v2(groups)
        group_index = next((index for index, item in enumerate(groups) if item.id == proposal["group_id"]), None)
        if group_index is None:
            raise PreferenceConflictError("proposal target group no longer exists")
        current = groups[group_index]
        detail_by_rule: dict[str, dict[str, Any]] = {}
        noop_changes: list[dict[str, Any]] = []
        for change in selected:
            action = change["action"]
            final_text = sanitize_text(data["edited_texts"].get(change["change_id"], change.get("proposed_text") or "")).text if action in {"add", "replace"} else None
            decision = "accepted_with_edits" if change["change_id"] in data["edited_texts"] else "accepted"
            rules = list(current.rules)
            if action == "add":
                if any(item.text == final_text for item in rules):
                    raise PreferenceConflictError("accepted add duplicates a current rule")
                new_rule = PreferenceRuleV2(new_id("rule-"), 1, final_text, True)
                rules.append(new_rule); detail_by_rule[new_rule.id] = {"change_id": change["change_id"], "evidence_refs": change["evidence_refs"], "decision": decision}
            elif action in {"replace", "delete"}:
                ref = change["rule_ref"]
                index = next((idx for idx, item in enumerate(rules) if item.id == ref["rule_id"] and item.revision == ref["revision"] and item.text == ref["text"] and _digest(item.to_dict()) == ref["digest"]), None)
                if index is None:
                    raise PreferenceConflictError("accepted change no longer matches the exact rule revision")
                old = rules[index]
                detail_by_rule[old.id] = {"change_id": change["change_id"], "evidence_refs": change["evidence_refs"], "decision": decision}
                if action == "replace":
                    if any(item.id != old.id and item.text == final_text for item in rules):
                        raise PreferenceConflictError("accepted replacement duplicates another current rule")
                    rules[index] = PreferenceRuleV2(old.id, old.revision + 1, final_text, old.enabled)
                else:
                    rules.pop(index)
            else:
                noop_changes.append(change)
                continue
            current = PreferenceGroupV2(current.id, current.revision + 1, current.name, current.description, rules)
        groups[group_index] = current
        after_doc = groups_document_v2(groups)
        operation_id = new_id("operation-")
        effects = build_group_effects(before_doc, after_doc, source_kind="proposal_accept", proposal_id=proposal["proposal_id"], change_details=detail_by_rule)
        for change in noop_changes:
            effects.append({"action": "noop", "group_id": proposal["group_id"], "group_before": None, "group_after": None, "rule_id": None, "before_rule": None, "after_rule": None, "source_kind": "proposal_accept", "proposal_id": proposal["proposal_id"], "change_id": change["change_id"], "evidence_refs": change["evidence_refs"], "decision": "accepted"})
        evidence_refs = list({(_ref_key(ref)): stable_json_dumps(ref) for item in selected for ref in item["evidence_refs"]}.values())
        evidence_ref_values = [json.loads(item) for item in evidence_refs]
        commit = None
        if before_doc != after_doc:
            transaction = begin_generated_transaction(store.repo, data_root=self.root)
            record = operation_record(
                operation_id=operation_id,
                transaction_id=generated_transaction_id(transaction),
                kind="proposal_apply",
                source_kind="proposal_accept",
                before_groups=before_doc,
                after_groups=after_doc,
                effects=effects,
                proposal_id=proposal["proposal_id"],
                change_ids=[item["change_id"] for item in selected],
                evidence_refs=evidence_ref_values,
                decision_fingerprints=[_change_fingerprint(proposal, item) for item in selected],
            )
            try:
                store.write_groups_v2(groups)
                write_operation_path(self.root, record)
                commit = commit_generated(store.repo, "personal-preferences: apply proposal")
                if not commit:
                    raise PreferenceGitError("proposal apply did not create a Git commit")
                complete_generated_transaction(transaction)
            except Exception:
                restore_generated_transaction(transaction); raise
        else:
            # noop acceptance remains local and does not create a misleading
            # formal-rule commit.
            operation_id = None
        decisions = self._decisions(); receipts = self._receipts(); decided_at = utc_now()
        for change in selected:
            decision = "accepted_with_edits" if change["change_id"] in data["edited_texts"] else "accepted"
            final_text = sanitize_text(data["edited_texts"].get(change["change_id"], change.get("proposed_text") or "")).text if change["action"] in {"add", "replace"} else None
            local_decision = self._decision(proposal, change, decision, None, operation_id=operation_id); decisions.append(local_decision)
            change.update({"state": "applied", "review": {"decision": decision, "decided_at": decided_at, "final_text": final_text, "reason": None, "operation_id": operation_id}})
            receipts.append({"proposal_id": proposal["proposal_id"], "change_id": change["change_id"], "operation_id": operation_id, "recovered_at": decided_at})
        if before_doc != after_doc:
            for change in proposal["changes"]:
                if change not in selected and change["state"] in {"pending_review", "deferred"}:
                    change["state"] = "stale"
                    change["gate_result"]["reasons"] = list(dict.fromkeys([*change["gate_result"]["reasons"], "same_batch_base_changed"]))
        proposal.update({"generation": proposal["generation"] + 1, "updated_at": decided_at, "state": _proposal_state(proposal["changes"])})
        result = {"proposal": copy.deepcopy(proposal), "operation_id": operation_id, "commit": commit, "idempotent": False}
        try:
            self._commit({self.proposals_path: _json_bytes(proposals), self.decisions_path: _json_bytes(decisions), self.receipts_path: _json_bytes(receipts)}, request=(request_id, _digest({"action": "accept", "payload": data}), result))
        except Exception:
            if commit is None:
                raise
            # The Git operation is authoritative.  A later list/get/accept
            # reconstructs the local receipt from changes/<operation-id>.json.
            return {**result, "receipt_pending_recovery": True}, self._cas()
        return result, self._cas(proposals=proposals)

    def prepare_group_delete(self, group_id: str) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        checked = _id(group_id, "group_id"); proposals = self._proposals(); jobs = self._jobs(); changed = False
        for proposal in proposals:
            if proposal["group_id"] == checked:
                changed = self._mark_stale(proposal, "group_deleted") or changed
        removed_jobs = [item["job_id"] for item in jobs if item["group_id"] == checked and item["state"] != "completed"]
        kept_jobs = [item for item in jobs if item["job_id"] not in removed_jobs]
        writes: dict[Path, bytes | None] = {}
        if changed:
            writes[self.proposals_path] = _json_bytes(proposals)
        if removed_jobs:
            writes[self.jobs_path] = _json_bytes(kept_jobs)
        worker = self._worker()
        if isinstance(worker, dict) and worker.get("job_id") in removed_jobs:
            writes[self.worker_path] = None
        if writes:
            state = copy.deepcopy(self._state()); state["collection_revision"] += 1; writes[self.state_path] = _json_bytes(state)
        return {"stale_proposals": [item["proposal_id"] for item in proposals if item["group_id"] == checked], "removed_proposal_jobs": removed_jobs}, writes

    def prepare_group_evidence_change(self, group_id: str) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        checked = _id(group_id, "group_id"); proposals = self._proposals(); stale: list[str] = []
        for proposal in proposals:
            if proposal["group_id"] == checked and self._mark_stale(proposal, "new_group_evidence"):
                stale.append(proposal["proposal_id"])
        if not stale:
            return {"stale_proposals": []}, {}
        state = copy.deepcopy(self._state()); state["collection_revision"] += 1
        return {"stale_proposals": stale}, {self.proposals_path: _json_bytes(proposals), self.state_path: _json_bytes(state)}

    def prepare_evidence_change(self, evidence_id: str) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        checked = _id(evidence_id, "evidence_id"); proposals = self._proposals(); stale: list[str] = []
        for proposal in proposals:
            if any(ref["evidence_id"] == checked for ref in proposal["evidence_refs"]) and self._mark_stale(proposal, "evidence_changed"):
                stale.append(proposal["proposal_id"])
        if not stale:
            return {"stale_proposals": []}, {}
        state = copy.deepcopy(self._state()); state["collection_revision"] += 1
        return {"stale_proposals": stale}, {self.proposals_path: _json_bytes(proposals), self.state_path: _json_bytes(state)}

    def impact(self, evidence_id: str) -> dict[str, Any]:
        checked = _id(evidence_id, "evidence_id")
        candidates = []
        for proposal in self._proposals():
            affected = [item["change_id"] for item in proposal["changes"] if any(ref["evidence_id"] == checked for ref in item["evidence_refs"])]
            if affected:
                candidates.append({"proposal_id": proposal["proposal_id"], "change_ids": affected, "state": proposal["state"]})
        formal_rules = []
        visible_revision_ids = set(EvidenceStore(self.root).revisions()[0])
        for operation in load_operation_records(self.root):
            for effect in operation["effects"]:
                refs = effect.get("evidence_refs", [])
                if any(ref["evidence_id"] == checked for ref in refs):
                    visibility = "available_on_this_device" if all(ref["revision_id"] in visible_revision_ids for ref in refs) else "source_only_on_origin_device"
                    formal_rules.append({"operation_id": operation["operation_id"], "group_id": effect.get("group_id"), "rule_id": effect.get("rule_id"), "after_rule": effect.get("after_rule"), "source_visibility": visibility})
        return {"candidates": candidates, "formal_rules": formal_rules, "candidate_impact_available": True}


def _git(root: Path, *args: str, check: bool = True) -> str:
    try:
        result = subprocess.run(["git", "-C", str(root), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=False, timeout=120)
    except (OSError, subprocess.SubprocessError) as exc:
        raise PreferenceGitError(f"cannot inspect preference Git history: {exc}") from exc
    if check and result.returncode != 0:
        raise PreferenceGitError(sanitize_text(result.stderr.strip() or result.stdout.strip()).text[:500])
    return result.stdout.strip()


def rollback_preview(root: str | Path) -> dict[str, Any]:
    from .git_sync import ensure_generated_transaction_ready, repository_head
    from .store import PreferenceStore
    store = PreferenceStore(root); repo = ensure_generated_transaction_ready(store.repo); head = repository_head(repo)
    if head is None:
        raise PreferenceGitError("preference repository has no rollback target")
    operations = {item["operation_id"]: item for item in load_operation_records(store.root)}
    reverted = {item["reverts_operation_id"] for item in operations.values() if item["kind"] == "rollback" and item["reverts_operation_id"]}
    target: dict[str, Any] | None = None; target_commit: str | None = None
    for commit in _git(repo, "log", "--format=%H", "--", "changes").splitlines():
        names = _git(repo, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit).splitlines()
        for name in names:
            if not name.startswith("changes/") or not name.endswith(".json"):
                continue
            operation_id = Path(name).stem
            operation = operations.get(operation_id)
            if operation and operation["kind"] in _RULE_OPERATION_KINDS - {"rollback"} and operation_id not in reverted:
                target = operation; target_commit = commit; break
        if target is not None:
            break
    if target is None or target_commit is None:
        raise PreferenceGitError("no latest preference operation is available to roll back")
    current_doc = groups_document_v2(store.read_groups_v2())
    if _digest(_operation_group_view(current_doc, target["effects"])) != target["groups_after_digest"]:
        raise PreferenceConflictError("current groups no longer match the rollback target")
    parent_spec = f"{target_commit}^:groups.json"
    before_text = _git(repo, "show", parent_spec)
    try:
        before_doc = json.loads(before_text)
    except json.JSONDecodeError as exc:
        raise PreferenceIntegrityError("rollback target groups are unreadable") from exc
    diff = _git(repo, "diff", f"{target_commit}^", target_commit, "--", "groups.json")
    return {
        "target_operation_id": target["operation_id"], "target_commit": target_commit, "expected_head": head,
        "created_at": target["created_at"], "kind": target["kind"], "effects": target["effects"],
        "diff": diff, "restore_groups": before_doc,
    }


def apply_rollback(root: str | Path, payload: Any) -> dict[str, Any]:
    data = _strict(payload, {"expected_operation_id", "expected_head"}, "rollback confirmation")
    preview = rollback_preview(root)
    if data["expected_operation_id"] != preview["target_operation_id"] or data["expected_head"] != preview["expected_head"]:
        raise PreferenceConflictError("rollback target or HEAD changed after preview")
    from .store import PreferenceStore
    from .git_sync import begin_generated_transaction, commit_generated, complete_generated_transaction, restore_generated_transaction
    store = PreferenceStore(root); before_doc = groups_document_v2(store.read_groups_v2())
    restored_groups = [PreferenceGroupV2.from_dict(item) for item in preview["restore_groups"]["groups"]]
    after_doc = groups_document_v2(restored_groups); operation_id = new_id("operation-")
    effects = build_group_effects(before_doc, after_doc, source_kind="rollback")
    transaction = begin_generated_transaction(store.repo, data_root=store.root)
    record = operation_record(
        operation_id=operation_id,
        transaction_id=generated_transaction_id(transaction),
        kind="rollback",
        source_kind="rollback",
        before_groups=before_doc,
        after_groups=after_doc,
        effects=effects,
        reverts_operation_id=preview["target_operation_id"],
    )
    try:
        store.write_groups_v2(restored_groups); write_operation_path(store.root, record)
        commit = commit_generated(store.repo, "personal-preferences: rollback")
        if not commit:
            raise PreferenceGitError("rollback did not create a Git commit")
        complete_generated_transaction(transaction)
    except Exception:
        restore_generated_transaction(transaction); raise
    stale = ProposalStore(store.root).revalidate_all()
    return {"operation_id": operation_id, "reverts_operation_id": preview["target_operation_id"], "commit": commit, **stale}
