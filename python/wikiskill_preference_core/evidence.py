"""Immutable EvidenceRevision storage, effective DAG views, and explicit publication."""

from __future__ import annotations

import copy
import json
import re
from collections import deque
from pathlib import Path
from typing import Any, Iterable, Mapping

from .contracts import new_id, stable_hash, stable_json_dumps, utc_now
from .errors import PreferenceConflictError, PreferenceContractError, PreferenceGitError, PreferenceIntegrityError
from .learning_contracts import EvidenceRevision, cas_for
from .transactions import PersistentTransaction

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_STATE_SCHEMA_VERSION = 1
_MAX_REQUEST_RECORDS = 256
_MUTABLE_CONTENT_FIELDS = {
    "task_summary", "evidence_summary", "feedback_target", "observations", "actual_behavior",
    "expected_behavior", "applicability", "nature", "specificity", "confidence", "needs_review",
    "context_completeness",
}
_IMMUTABLE_ORIGIN_FIELDS = ("origin_task_key", "origin_verified", "feedback_id")


class EvidenceNotFoundError(PreferenceContractError):
    """The requested latest-format evidence identity has no revisions."""


class EvidenceWithdrawnError(PreferenceConflictError):
    """Extractor output cannot cross a withdrawal without a user restore."""


def _id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _ID_RE.fullmatch(value):
        raise PreferenceContractError(f"{label} must be a path-safe identifier")
    return value


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or isinstance(value, list):
        raise PreferenceContractError(f"{label} must be an object")
    return dict(value)


def _strict(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    data = _object(value, label)
    if set(data) != keys:
        raise PreferenceContractError(f"{label} has an invalid schema")
    return data


def _digest(value: Any) -> str:
    return f"sha256:{stable_hash(value)}"


def _revision_bytes(revision: Mapping[str, Any]) -> bytes:
    return (stable_json_dumps(dict(revision)) + "\n").encode("utf-8")


def _heads(revisions: Mapping[str, Mapping[str, Any]]) -> list[str]:
    parented = {parent for revision in revisions.values() for parent in revision["parents"]}
    return sorted(set(revisions) - parented)


class EvidenceStore:
    """The only writer and validator for latest-format evidence revisions."""

    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.local_root = self.root / "local" / "evidence"
        self.repo_root = self.root / "repo" / "evidence"
        self.state_path = self.root / "local" / "evidence-state.json"

    def _state(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"schema_version": _STATE_SCHEMA_VERSION, "generation": 0, "requests": {}}
        if self.state_path.is_symlink() or not self.state_path.is_file():
            raise PreferenceIntegrityError("evidence state must be a regular file")
        try:
            value = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceIntegrityError("evidence state is unreadable") from exc
        if not isinstance(value, dict) or set(value) != {"schema_version", "generation", "requests"}:
            raise PreferenceIntegrityError("evidence state has an invalid schema")
        if value["schema_version"] != _STATE_SCHEMA_VERSION or type(value["generation"]) is not int or value["generation"] < 0:
            raise PreferenceIntegrityError("evidence state has an invalid generation")
        requests = value["requests"]
        if not isinstance(requests, dict) or len(requests) > _MAX_REQUEST_RECORDS:
            raise PreferenceIntegrityError("evidence request records are invalid")
        for request_id, record in requests.items():
            _id(request_id, "evidence request id")
            if not isinstance(record, dict) or set(record) != {"input_digest", "data"}:
                raise PreferenceIntegrityError("evidence request record is invalid")
            if not isinstance(record["input_digest"], str) or not record["input_digest"].startswith("sha256:"):
                raise PreferenceIntegrityError("evidence request digest is invalid")
            if not isinstance(record["data"], dict):
                raise PreferenceIntegrityError("evidence request result is invalid")
        return value

    def _next_state(
        self,
        *,
        request_id: str | None = None,
        input_digest: str | None = None,
        data: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        state = copy.deepcopy(self._state())
        state["generation"] += 1
        if request_id is not None:
            if input_digest is None or data is None:
                raise PreferenceIntegrityError("evidence request record is incomplete")
            requests = state["requests"]
            requests[request_id] = {"input_digest": input_digest, "data": copy.deepcopy(dict(data))}
            while len(requests) > _MAX_REQUEST_RECORDS:
                requests.pop(next(iter(requests)))
        return state

    def _request_result(self, request_id: str, input_digest: str) -> dict[str, Any] | None:
        record = self._state()["requests"].get(_id(request_id, "request_id"))
        if record is None:
            return None
        if record["input_digest"] != input_digest:
            raise PreferenceConflictError("request_id was already used with different evidence input")
        return copy.deepcopy(record["data"])

    def _revision_path(self, location: str, evidence_id: str, revision_id: str) -> Path:
        base = self.local_root if location == "local" else self.repo_root
        return base / _id(evidence_id, "evidence_id") / f"{_id(revision_id, 'revision_id')}.json"

    def _scan_location(self, location: str) -> dict[str, dict[str, Any]]:
        root = self.local_root if location == "local" else self.repo_root
        result: dict[str, dict[str, Any]] = {}
        if not root.exists():
            return result
        if root.is_symlink() or not root.is_dir():
            raise PreferenceIntegrityError(f"{location} evidence root must be a regular directory")
        for evidence_dir in sorted(root.iterdir(), key=lambda item: item.name):
            if evidence_dir.is_symlink() or not evidence_dir.is_dir() or not _ID_RE.fullmatch(evidence_dir.name):
                raise PreferenceIntegrityError(f"unsafe {location} evidence entry: {evidence_dir.name}")
            for path in sorted(evidence_dir.iterdir(), key=lambda item: item.name):
                if path.is_symlink() or not path.is_file() or path.suffix != ".json" or not _ID_RE.fullmatch(path.stem):
                    raise PreferenceIntegrityError(f"unsafe {location} evidence revision: {path}")
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    raise PreferenceIntegrityError(f"evidence revision is unreadable: {path}") from exc
                try:
                    revision = EvidenceRevision.from_dict(raw).to_dict()
                except PreferenceContractError as exc:
                    raise PreferenceIntegrityError(f"evidence revision contract is invalid: {path}") from exc
                if revision["evidence_id"] != evidence_dir.name or revision["revision_id"] != path.stem:
                    raise PreferenceIntegrityError("evidence revision path does not match its identifiers")
                revision_id = revision["revision_id"]
                if revision_id in result and result[revision_id] != revision:
                    raise PreferenceIntegrityError(f"revision ID has different content: {revision_id}")
                result[revision_id] = revision
        return result

    def revisions(self) -> tuple[dict[str, dict[str, Any]], set[str], set[str]]:
        local = self._scan_location("local")
        repo = self._scan_location("repo")
        combined = dict(local)
        for revision_id, revision in repo.items():
            existing = combined.get(revision_id)
            if existing is not None and existing != revision:
                raise PreferenceIntegrityError(f"local and repo revisions differ: {revision_id}")
            combined[revision_id] = revision
        by_evidence: dict[str, dict[str, dict[str, Any]]] = {}
        for revision_id, revision in combined.items():
            by_evidence.setdefault(revision["evidence_id"], {})[revision_id] = revision
        for evidence_id, values in by_evidence.items():
            self._validate_dag(evidence_id, values, combined)
        return combined, set(local), set(repo)

    def _validate_dag(
        self,
        evidence_id: str,
        revisions: Mapping[str, Mapping[str, Any]],
        all_revisions: Mapping[str, Mapping[str, Any]],
    ) -> None:
        for revision_id, revision in revisions.items():
            parents = revision["parents"]
            operation = revision["operation"]
            author_kind = revision["author_kind"]
            if not parents and (operation != "upsert" or author_kind != "extractor"):
                raise PreferenceIntegrityError("an initial evidence revision must be an extractor upsert")
            if operation == "restore":
                if author_kind != "user" or not parents:
                    raise PreferenceIntegrityError("restore requires an explicit user-authored revision")
            elif operation == "withdraw":
                if author_kind not in {"user", "host"}:
                    raise PreferenceIntegrityError("extractors cannot withdraw evidence")
            elif author_kind not in {"user", "extractor"}:
                raise PreferenceIntegrityError("host-authored evidence revisions may only withdraw")
            if parents:
                for parent in parents:
                    parent_revision = all_revisions.get(parent)
                    if parent_revision is None:
                        raise PreferenceIntegrityError(f"evidence parent is missing: {parent}")
                    if parent_revision["evidence_id"] != evidence_id:
                        raise PreferenceIntegrityError("evidence parent belongs to another evidence ID")
                    for field in _IMMUTABLE_ORIGIN_FIELDS:
                        if revision[field] != parent_revision[field]:
                            raise PreferenceIntegrityError(f"host-owned evidence origin changed: {field}")
                parent_operations = {all_revisions[parent]["operation"] for parent in parents}
                if operation == "restore" and "withdraw" not in parent_operations:
                    raise PreferenceIntegrityError("restore must directly resolve a withdrawal head")
                if operation == "upsert" and "withdraw" in parent_operations:
                    raise PreferenceIntegrityError("withdrawal must be followed by an explicit user restore before upsert")
            if revision_id in parents or len(parents) != len(set(parents)):
                raise PreferenceIntegrityError("evidence parents contain a self-reference or duplicate")

        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(revision_id: str) -> None:
            if revision_id in visiting:
                raise PreferenceIntegrityError("evidence revision graph contains a cycle")
            if revision_id in visited:
                return
            visiting.add(revision_id)
            for parent in revisions[revision_id]["parents"]:
                visit(parent)
            visiting.remove(revision_id)
            visited.add(revision_id)

        for revision_id in revisions:
            visit(revision_id)

    def _groups(self) -> set[str]:
        from .store import PreferenceStore
        return {group.id for group in PreferenceStore(self.root).read_groups_v2()}

    def view(self) -> dict[str, Any]:
        combined, local_ids, repo_ids = self.revisions()
        grouped: dict[str, dict[str, dict[str, Any]]] = {}
        for revision_id, revision in combined.items():
            grouped.setdefault(revision["evidence_id"], {})[revision_id] = revision
        groups = self._groups()
        evidence: list[dict[str, Any]] = []
        for evidence_id in sorted(grouped):
            revisions = grouped[evidence_id]
            heads = _heads(revisions)
            head_values = [revisions[item] for item in heads]
            published = any(item in repo_ids for item in revisions)
            unpublished_heads = [item for item in heads if item not in repo_ids]
            if any(item["operation"] == "withdraw" for item in head_values):
                status = "withdrawn"
                active_revision = None
            elif len(heads) != 1:
                status = "conflict"
                active_revision = None
            else:
                active_revision = heads[0]
                status = "active" if revisions[active_revision]["group_id"] in groups else "orphaned_group"
                if status != "active":
                    active_revision = None
            withdrawal_pending_publish = published and any(
                revisions[item]["operation"] == "withdraw" and item not in repo_ids
                for item in heads
            )
            publish_state = (
                "withdrawal_pending_publish" if withdrawal_pending_publish
                else "changes_pending_publish" if published and unpublished_heads
                else "published" if published
                else "local_only"
            )
            evidence.append({
                "evidence_id": evidence_id,
                "status": status,
                "heads": heads,
                "active_revision_id": active_revision,
                "published": published,
                "publish_state": publish_state,
                "withdrawal_pending_publish": withdrawal_pending_publish,
                "unpublished_head_ids": unpublished_heads,
                "revision_count": len(revisions),
                "local_revision_count": sum(item in local_ids for item in revisions),
                "repo_revision_count": sum(item in repo_ids for item in revisions),
                "group_id": head_values[0]["group_id"] if len(head_values) == 1 else None,
                "revision": copy.deepcopy(revisions[active_revision]) if active_revision else None,
            })
        return {"evidence": evidence}

    def cas(self) -> dict[str, Any]:
        state = self._state()
        return cas_for("evidence", state["generation"], self.view()).to_dict()

    def list(self) -> tuple[dict[str, Any], dict[str, Any]]:
        return self.view(), self.cas()

    def get(self, evidence_id: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        checked = _id(evidence_id, "evidence_id")
        combined, local_ids, repo_ids = self.revisions()
        revisions = {key: value for key, value in combined.items() if value["evidence_id"] == checked}
        if not revisions:
            raise PreferenceContractError("evidence does not exist")
        summary = next(item for item in self.view()["evidence"] if item["evidence_id"] == checked)
        return {
            **summary,
            "revisions": [
                {**copy.deepcopy(revisions[key]), "locations": [
                    *( ["local"] if key in local_ids else []),
                    *( ["repo"] if key in repo_ids else []),
                ]}
                for key in sorted(revisions)
            ],
        }, self.cas()

    def _evidence_revisions(self, evidence_id: str) -> dict[str, dict[str, Any]]:
        combined, _local, _repo = self.revisions()
        values = {key: value for key, value in combined.items() if value["evidence_id"] == evidence_id}
        if not values:
            raise EvidenceNotFoundError("evidence does not exist")
        return values

    def _check_precondition(
        self,
        evidence_id: str,
        payload: Mapping[str, Any],
        expected_generation: int | None,
    ) -> tuple[dict[str, dict[str, Any]], list[str]]:
        revisions = self._evidence_revisions(evidence_id)
        heads = _heads(revisions)
        expected_heads = payload.get("expected_heads")
        if expected_heads is not None:
            if not isinstance(expected_heads, list) or any(not isinstance(item, str) for item in expected_heads):
                raise PreferenceContractError("expected_heads must be a list of revision IDs")
            checked_heads = sorted(_id(item, "expected_heads item") for item in expected_heads)
            if len(checked_heads) != len(set(checked_heads)):
                raise PreferenceContractError("expected_heads must not contain duplicates")
            if checked_heads != heads:
                raise PreferenceConflictError("evidence heads changed")
            return revisions, heads
        expected_digest = payload.get("expected_digest")
        current = self.cas()
        if expected_generation != current["generation"] or expected_digest != current["digest"]:
            raise PreferenceConflictError("evidence generation or digest changed")
        return revisions, heads

    def _commit_local_writes(self, writes: Mapping[Path, bytes | None]) -> None:
        transaction = PersistentTransaction.begin_local(self.root, writes)
        try:
            transaction.apply()
            transaction.commit_local()
        except Exception:
            transaction.rollback()
            raise

    def _recorded_write(
        self,
        request_id: str,
        action: str,
        payload: Mapping[str, Any],
        expected_generation: int | None,
        builder: Any,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        checked_request = _id(request_id, "request_id")
        input_digest = _digest({"action": action, "payload": dict(payload), "expected_generation": expected_generation})
        previous = self._request_result(checked_request, input_digest)
        if previous is not None:
            return previous, self.cas()
        data, writes = builder()
        state = self._next_state(request_id=checked_request, input_digest=input_digest, data=data)
        all_writes = dict(writes)
        all_writes[self.state_path] = _revision_bytes(state)
        self._commit_local_writes(all_writes)
        return copy.deepcopy(data), self.cas()

    def _base_content(self, revisions: Mapping[str, Mapping[str, Any]], heads: Iterable[str], base_revision_id: Any = None) -> dict[str, Any]:
        if base_revision_id is not None:
            checked = _id(base_revision_id, "base_revision_id")
            if checked not in revisions or revisions[checked]["content"] is None:
                raise PreferenceContractError("base_revision_id must identify a content revision")
            return copy.deepcopy(revisions[checked]["content"])
        content_heads = [revisions[item] for item in heads if revisions[item]["content"] is not None]
        if len(content_heads) == 1:
            return copy.deepcopy(content_heads[0]["content"])
        raise PreferenceContractError("a conflicting evidence revision requires an explicit base_revision_id")

    def revise(
        self,
        request_id: str,
        payload: Mapping[str, Any],
        expected_generation: int | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _object(payload, "evidence revise")
        allowed = {"evidence_id", "expected_heads", "expected_digest", "base_revision_id", "group_id", "patch"}
        if set(data) - allowed or "evidence_id" not in data or "patch" not in data:
            raise PreferenceContractError("evidence revise has an invalid schema")
        evidence_id = _id(data["evidence_id"], "evidence_id")

        def build() -> tuple[dict[str, Any], dict[Path, bytes | None]]:
            revisions, heads = self._check_precondition(evidence_id, data, expected_generation)
            if any(revisions[item]["operation"] == "withdraw" for item in heads):
                raise PreferenceContractError("withdrawn evidence must be restored explicitly")
            patch = _object(data["patch"], "evidence patch")
            if set(patch) - _MUTABLE_CONTENT_FIELDS or (not patch and "group_id" not in data):
                raise PreferenceContractError("evidence patch contains unsupported or no fields")
            content = self._base_content(revisions, heads, data.get("base_revision_id"))
            content.update(copy.deepcopy(patch))
            group_id = data.get("group_id", revisions[heads[0]]["group_id"] if heads else None)
            _id(group_id, "group_id")
            if group_id not in self._groups():
                raise PreferenceContractError("group_id does not identify an existing group")
            origin = revisions[heads[0]]
            revision = {
                "schema_version": 1,
                "evidence_id": evidence_id,
                "revision_id": new_id("revision-"),
                "parents": heads,
                "operation": "upsert",
                "recorded_at": utc_now(),
                "author_kind": "user",
                "origin_task_key": origin["origin_task_key"],
                "origin_verified": origin["origin_verified"],
                "feedback_id": origin["feedback_id"],
                "group_id": group_id,
                "content": content,
            }
            EvidenceRevision.from_dict(revision)
            from .proposals import ProposalStore
            proposal_result, proposal_writes = ProposalStore(self.root).prepare_evidence_change(evidence_id)
            result = {"evidence_revision": revision, "resolved_heads": heads, **proposal_result}
            return result, {self._revision_path("local", evidence_id, revision["revision_id"]): _revision_bytes(revision), **proposal_writes}

        return self._recorded_write(request_id, "revise", data, expected_generation, build)

    def withdraw(
        self,
        request_id: str,
        payload: Mapping[str, Any],
        expected_generation: int | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _object(payload, "evidence withdraw")
        if not {"evidence_id"} <= set(data) or set(data) - {"evidence_id", "expected_heads", "expected_digest"}:
            raise PreferenceContractError("evidence withdraw has an invalid schema")
        evidence_id = _id(data["evidence_id"], "evidence_id")

        def build() -> tuple[dict[str, Any], dict[Path, bytes | None]]:
            revisions, heads = self._check_precondition(evidence_id, data, expected_generation)
            if any(revisions[item]["operation"] == "withdraw" for item in heads):
                return {"evidence_id": evidence_id, "withdrawn": True, "idempotent": True}, {}
            origin = revisions[heads[0]]
            revision = self._withdraw_revision(origin, heads, author_kind="user")
            from .proposals import ProposalStore
            proposal_result, proposal_writes = ProposalStore(self.root).prepare_evidence_change(evidence_id)
            return {"evidence_revision": revision, **proposal_result}, {self._revision_path("local", evidence_id, revision["revision_id"]): _revision_bytes(revision), **proposal_writes}

        return self._recorded_write(request_id, "withdraw", data, expected_generation, build)

    def _withdraw_revision(
        self,
        origin: Mapping[str, Any],
        parents: list[str],
        *,
        author_kind: str = "host",
    ) -> dict[str, Any]:
        revision = {
            "schema_version": 1,
            "evidence_id": origin["evidence_id"],
            "revision_id": new_id("revision-"),
            "parents": sorted(parents),
            "operation": "withdraw",
            "recorded_at": utc_now(),
            "author_kind": author_kind,
            "origin_task_key": origin["origin_task_key"],
            "origin_verified": origin["origin_verified"],
            "feedback_id": origin["feedback_id"],
            "group_id": origin["group_id"],
            "content": None,
        }
        EvidenceRevision.from_dict(revision)
        return revision

    def _restore_content(
        self,
        revisions: Mapping[str, Mapping[str, Any]],
        heads: list[str],
        content_revision_id: Any,
    ) -> dict[str, Any]:
        if content_revision_id is not None:
            return self._base_content(revisions, heads, content_revision_id)
        queue = deque((head, 0) for head in heads)
        seen: set[str] = set()
        found_depth: int | None = None
        found: list[dict[str, Any]] = []
        while queue:
            revision_id, depth = queue.popleft()
            if revision_id in seen or (found_depth is not None and depth > found_depth):
                continue
            seen.add(revision_id)
            revision = revisions[revision_id]
            if revision["content"] is not None:
                found_depth = depth
                found.append(revision["content"])
                continue
            queue.extend((parent, depth + 1) for parent in revision["parents"])
        unique = {stable_json_dumps(item): item for item in found}
        if len(unique) != 1:
            raise PreferenceContractError("restore requires content_revision_id because prior content is ambiguous")
        return copy.deepcopy(next(iter(unique.values())))

    def restore(
        self,
        request_id: str,
        payload: Mapping[str, Any],
        expected_generation: int | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _object(payload, "evidence restore")
        if not {"evidence_id", "expected_heads"} <= set(data) or set(data) - {"evidence_id", "expected_heads", "content_revision_id", "group_id"}:
            raise PreferenceContractError("evidence restore has an invalid schema")
        evidence_id = _id(data["evidence_id"], "evidence_id")

        def build() -> tuple[dict[str, Any], dict[Path, bytes | None]]:
            revisions, heads = self._check_precondition(evidence_id, data, expected_generation)
            if not any(revisions[item]["operation"] == "withdraw" for item in heads):
                raise PreferenceContractError("only withdrawn evidence can be restored")
            content = self._restore_content(revisions, heads, data.get("content_revision_id"))
            origin = revisions[heads[0]]
            group_id = data.get("group_id", origin["group_id"])
            _id(group_id, "group_id")
            if group_id not in self._groups():
                raise PreferenceContractError("restore group_id does not identify an existing group")
            revision = {
                "schema_version": 1,
                "evidence_id": evidence_id,
                "revision_id": new_id("revision-"),
                "parents": heads,
                "operation": "restore",
                "recorded_at": utc_now(),
                "author_kind": "user",
                "origin_task_key": origin["origin_task_key"],
                "origin_verified": origin["origin_verified"],
                "feedback_id": origin["feedback_id"],
                "group_id": group_id,
                "content": content,
            }
            EvidenceRevision.from_dict(revision)
            from .jobs import FeedbackJobs
            jobs_result, job_writes = FeedbackJobs(self.root).prepare_evidence_restore(origin["feedback_id"])
            writes = {self._revision_path("local", evidence_id, revision["revision_id"]): _revision_bytes(revision)}
            writes.update(job_writes)
            from .proposals import ProposalStore
            proposal_result, proposal_writes = ProposalStore(self.root).prepare_evidence_change(evidence_id)
            writes.update(proposal_writes)
            return {"evidence_revision": revision, **jobs_result, **proposal_result}, writes

        return self._recorded_write(request_id, "restore", data, expected_generation, build)

    def delete_local(
        self,
        request_id: str,
        payload: Mapping[str, Any],
        expected_generation: int | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _object(payload, "evidence delete-local")
        if not {"evidence_id"} <= set(data) or set(data) - {"evidence_id", "expected_heads", "expected_digest"}:
            raise PreferenceContractError("evidence delete-local has an invalid schema")
        evidence_id = _id(data["evidence_id"], "evidence_id")

        def build() -> tuple[dict[str, Any], dict[Path, bytes | None]]:
            revisions, _heads_value = self._check_precondition(evidence_id, data, expected_generation)
            _combined, local_ids, repo_ids = self.revisions()
            if any(item in repo_ids for item in revisions):
                raise PreferenceContractError("published evidence cannot be deleted locally; withdraw it instead")
            writes = {
                self._revision_path("local", evidence_id, revision_id): None
                for revision_id in revisions if revision_id in local_ids
            }
            from .jobs import FeedbackJobs
            jobs_result, job_writes = FeedbackJobs(self.root).prepare_evidence_delete(set(revisions))
            writes.update(job_writes)
            from .proposals import ProposalStore
            proposal_result, proposal_writes = ProposalStore(self.root).prepare_evidence_change(evidence_id)
            writes.update(proposal_writes)
            return {"deleted": evidence_id, "revision_count": len(revisions), **jobs_result, **proposal_result}, writes

        return self._recorded_write(request_id, "delete-local", data, expected_generation, build)

    def impact(self, evidence_id: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        checked = _id(evidence_id, "evidence_id")
        detail, _cas = self.get(checked)
        jobs: list[str] = []
        jobs_path = self.root / "local" / "feedback-jobs.json"
        if jobs_path.exists() and not jobs_path.is_symlink():
            try:
                values = json.loads(jobs_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise PreferenceIntegrityError("feedback jobs are unreadable") from exc
            revision_ids = {item["revision_id"] for item in detail["revisions"]}
            jobs = sorted(
                item["job_id"] for item in values
                if isinstance(item, dict) and item.get("result_ref") in revision_ids and isinstance(item.get("job_id"), str)
            )
        from .proposals import ProposalStore
        proposal_impact = ProposalStore(self.root).impact(checked)
        return {
            "evidence_id": checked,
            "status": detail["status"],
            "feedback_jobs": jobs,
            **proposal_impact,
        }, self.cas()

    def _closure(self, revisions: Mapping[str, Mapping[str, Any]], revision_ids: Iterable[str]) -> set[str]:
        result: set[str] = set()
        stack = list(revision_ids)
        while stack:
            revision_id = stack.pop()
            if revision_id in result:
                continue
            if revision_id not in revisions:
                raise PreferenceIntegrityError(f"publication parent is missing: {revision_id}")
            result.add(revision_id)
            stack.extend(revisions[revision_id]["parents"])
        return result

    def preview_publish(self, payload: Mapping[str, Any], expected_generation: int | None) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _object(payload, "evidence publish preview")
        if not {"evidence_id"} <= set(data) or set(data) - {"evidence_id", "expected_heads", "expected_digest"}:
            raise PreferenceContractError("evidence publish preview has an invalid schema")
        evidence_id = _id(data["evidence_id"], "evidence_id")
        revisions, heads = self._check_precondition(evidence_id, data, expected_generation)
        _combined, _local_ids, repo_ids = self.revisions()
        closure = self._closure(revisions, heads)
        export_ids = sorted(item for item in closure if item not in repo_ids)
        entries = [
            {
                "evidence_id": evidence_id,
                "revision_id": revision_id,
                "operation": revisions[revision_id]["operation"],
                "parents": list(revisions[revision_id]["parents"]),
                "content_digest": _digest(revisions[revision_id]),
                "revision": copy.deepcopy(revisions[revision_id]),
            }
            for revision_id in export_ids
        ]
        preview_digest = _digest({"evidence_id": evidence_id, "heads": heads, "entries": entries})
        return {
            "evidence_id": evidence_id,
            "heads": heads,
            "entries": entries,
            "revision_ids": export_ids,
            "preview_digest": preview_digest,
        }, self.cas()

    def publish(
        self,
        request_id: str,
        payload: Mapping[str, Any],
        expected_generation: int | None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"evidence_id", "expected_heads", "preview_digest", "revision_ids"}, "evidence publish")
        checked_request = _id(request_id, "request_id")
        input_digest = _digest({"action": "publish", "payload": data, "expected_generation": expected_generation})
        previous = self._request_result(checked_request, input_digest)
        if previous is not None:
            return previous, self.cas()
        preview, _cas = self.preview_publish(
            {"evidence_id": data["evidence_id"], "expected_heads": data["expected_heads"]},
            expected_generation,
        )
        if data["preview_digest"] != preview["preview_digest"] or data["revision_ids"] != preview["revision_ids"]:
            raise PreferenceConflictError("publication preview changed or approval did not cover the full closure")
        evidence_id = _id(data["evidence_id"], "evidence_id")
        revisions = self._evidence_revisions(evidence_id)
        result = {
            "evidence_id": evidence_id,
            "published_revision_ids": list(preview["revision_ids"]),
            "preview_digest": preview["preview_digest"],
            "committed": True,
        }
        if not preview["revision_ids"]:
            result["idempotent"] = True
            state = self._next_state(request_id=checked_request, input_digest=input_digest, data=result)
            self._commit_local_writes({self.state_path: _revision_bytes(state)})
            return result, self.cas()

        from .git_sync import (
            begin_generated_transaction,
            commit_generated,
            complete_generated_transaction,
            restore_generated_transaction,
        )
        from .store import atomic_write_bytes, atomic_write_text

        transaction = begin_generated_transaction(
            self.root / "repo",
            extra_paths=(self.state_path,),
            data_root=self.root,
        )
        try:
            for revision_id in preview["revision_ids"]:
                atomic_write_bytes(self._revision_path("repo", evidence_id, revision_id), _revision_bytes(revisions[revision_id]))
            state = self._next_state(request_id=checked_request, input_digest=input_digest, data=result)
            atomic_write_text(self.state_path, stable_json_dumps(state) + "\n")
            commit = commit_generated(self.root / "repo", "personal-preferences: evidence publish")
            if not commit:
                raise PreferenceGitError("evidence publication did not create a Git commit")
            complete_generated_transaction(transaction)
        except Exception:
            restore_generated_transaction(transaction)
            raise
        return result, self.cas()

    def prepare_extracted_revision(
        self,
        job: Mapping[str, Any],
        snapshot: Mapping[str, Any],
        extracted: Mapping[str, Any],
        *,
        sanitizer_version: str,
        extractor_prompt_version: str,
    ) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        evidence_id = f"evidence-{stable_hash(job['job_id'])[:24]}"
        try:
            revisions = self._evidence_revisions(evidence_id)
        except EvidenceNotFoundError:
            revisions = {}
            heads = []
            origin = None
        else:
            heads = _heads(revisions)
            if len(heads) != 1:
                raise PreferenceConflictError("evidence has concurrent heads and requires an explicit user revision")
            origin = revisions[heads[0]]
            if origin["operation"] == "withdraw":
                raise EvidenceWithdrawnError("withdrawn evidence requires an explicit user restore before re-extraction")
        content = {
            "raw_feedback": job["feedback"],
            "feedback_created_at": job["created_at"],
            "task_summary": extracted["task_summary"],
            "evidence_summary": extracted["evidence_summary"],
            "feedback_target": {
                "type": extracted["target"]["type"],
                "description": extracted["target"]["description"],
                "quote": copy.deepcopy(extracted["quote"]),
            },
            "observations": copy.deepcopy(extracted["observations"]),
            "actual_behavior": extracted["actual_behavior"],
            "expected_behavior": extracted["expected_behavior"],
            "applicability": extracted["applicability"],
            "nature": extracted["nature"],
            "specificity": extracted["specificity"],
            "confidence": extracted["confidence"],
            "needs_review": extracted["needs_review"],
            "context_completeness": "complete",
            "sanitizer_version": sanitizer_version,
            "extractor_prompt_version": extractor_prompt_version,
        }
        revision = {
            "schema_version": 1,
            "evidence_id": evidence_id,
            "revision_id": new_id("revision-"),
            "parents": heads,
            "operation": "upsert",
            "recorded_at": utc_now(),
            "author_kind": "extractor",
            "origin_task_key": origin["origin_task_key"] if origin else snapshot["task_key"],
            "origin_verified": origin["origin_verified"] if origin else snapshot["origin_verified"],
            "feedback_id": origin["feedback_id"] if origin else job["job_id"],
            "group_id": job["group_id"],
            "content": content,
        }
        EvidenceRevision.from_dict(revision)
        state = self._next_state()
        from .proposals import ProposalStore
        _proposal_result, proposal_writes = ProposalStore(self.root).prepare_group_evidence_change(job["group_id"])
        return revision, {
            self._revision_path("local", evidence_id, revision["revision_id"]): _revision_bytes(revision),
            self.state_path: _revision_bytes(state),
            **proposal_writes,
        }

    def prepare_feedback_invalidation(self, feedback_id: str) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        checked = _id(feedback_id, "feedback_id")
        combined, local_ids, repo_ids = self.revisions()
        matched = {key: value for key, value in combined.items() if value["feedback_id"] == checked}
        if not matched:
            return {"invalidated": False}, {}
        evidence_ids = {item["evidence_id"] for item in matched.values()}
        if len(evidence_ids) != 1:
            raise PreferenceIntegrityError("one feedback job is linked to multiple evidence IDs")
        evidence_id = next(iter(evidence_ids))
        revisions = {key: value for key, value in combined.items() if value["evidence_id"] == evidence_id}
        heads = _heads(revisions)
        writes: dict[Path, bytes | None]
        result: dict[str, Any]
        if any(item in repo_ids for item in revisions):
            if any(revisions[item]["operation"] == "withdraw" for item in heads):
                return {"invalidated": True, "evidence_id": evidence_id, "already_withdrawn": True}, {}
            revision = self._withdraw_revision(revisions[heads[0]], heads)
            writes = {self._revision_path("local", evidence_id, revision["revision_id"]): _revision_bytes(revision)}
            result = {"invalidated": True, "evidence_id": evidence_id, "withdraw_revision_id": revision["revision_id"]}
        else:
            writes = {
                self._revision_path("local", evidence_id, revision_id): None
                for revision_id in revisions if revision_id in local_ids
            }
            result = {"invalidated": True, "evidence_id": evidence_id, "deleted_local": True}
        from .proposals import ProposalStore
        proposal_result, proposal_writes = ProposalStore(self.root).prepare_evidence_change(evidence_id)
        result.update(proposal_result)
        writes.update(proposal_writes)
        state = self._next_state()
        writes[self.state_path] = _revision_bytes(state)
        return result, writes

    def prepare_group_delete(self, group_id: str) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        checked = _id(group_id, "group_id")
        combined, local_ids, repo_ids = self.revisions()
        grouped: dict[str, dict[str, dict[str, Any]]] = {}
        for revision_id, revision in combined.items():
            grouped.setdefault(revision["evidence_id"], {})[revision_id] = revision
        writes: dict[Path, bytes | None] = {}
        deleted: list[str] = []
        preserved: list[str] = []
        for evidence_id, revisions in grouped.items():
            heads = _heads(revisions)
            if not any(revisions[item]["group_id"] == checked for item in heads):
                continue
            if any(item in repo_ids for item in revisions):
                preserved.append(evidence_id)
                continue
            deleted.append(evidence_id)
            for revision_id in revisions:
                if revision_id in local_ids:
                    writes[self._revision_path("local", evidence_id, revision_id)] = None
        if writes:
            writes[self.state_path] = _revision_bytes(self._next_state())
        return {"deleted_local_evidence": sorted(deleted), "preserved_published_evidence": sorted(preserved)}, writes
