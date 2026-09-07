"""Durable local feedback jobs.  Jobs never alter preference groups or rules."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .contracts import new_id, stable_hash, stable_json_dumps, utc_now
from .errors import PreferenceConflictError, PreferenceContractError, PreferenceError, PreferenceIntegrityError
from .evidence import EvidenceStore, EvidenceWithdrawnError
from .extraction import PROMPT_VERSION as EXTRACTOR_PROMPT_VERSION, extraction_prompt, parse_extraction
from .learning_contracts import FeedbackJob, cas_for, model_usage
from .sanitizing import (
    DEFAULT_DENIED_FILE_NAMES,
    SANITIZER_VERSION,
    path_is_denied,
    safe_relative_project_path,
    sanitize_text,
)
from .transactions import PersistentTransaction

_MAX_FEEDBACK = 2000
_MAX_CONTEXT = 4000
_PERMANENT_DISPATCH_ERRORS = {
    "invalid_config": "dispatch_invalid_config",
    "invalid_contract": "dispatch_invalid_contract",
    "integrity_error": "dispatch_integrity_error",
    "internal_error": "dispatch_internal_error",
    "unsupported_action": "dispatch_unsupported_action",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_after(seconds: int) -> str:
    return (_now() + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def _parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _strict(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise PreferenceContractError(f"{label} has an invalid schema")
    return dict(value)


def _id(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 or any(char.isspace() for char in value):
        raise PreferenceContractError(f"{label} must be a path-safe identifier")
    return value


def _selection(value: Any) -> dict[str, Any]:
    data = _strict(value, {
        "provider_source", "provider_id", "model_id", "api_type", "endpoint_fingerprint",
        "thinking_level", "max_tokens", "timeout_seconds", "config_version",
    }, "model_selection")
    # FeedbackJob is the canonical strict validator and also makes a defensive copy.
    probe = _job("probe-job", "probe-request", "probe", None, {}, data, 0)
    return FeedbackJob.from_dict(probe).to_dict()["model_selection"]


def _snapshot(value: Any) -> dict[str, Any]:
    data = _strict(value, {"session_id", "task_key", "user_entry_id", "assistant_entry_id", "user_text", "assistant_text", "origin_verified", "storage_mode"}, "feedback snapshot")
    for key in ("session_id", "task_key", "user_entry_id", "assistant_entry_id"):
        _id(data[key], f"snapshot.{key}")
    if data["storage_mode"] not in {"local_only", "ask"}: raise PreferenceContractError("snapshot.storage_mode is unsupported")
    if data["origin_verified"] is not True: raise PreferenceContractError("snapshot.origin_verified must be true for a feedback target")
    result = dict(data)
    for key in ("user_text", "assistant_text"):
        value = data[key]
        if not isinstance(value, str) or not value.strip() or len(value) > _MAX_CONTEXT: raise PreferenceContractError(f"snapshot.{key} must be a non-empty bounded string")
        result[key] = sanitize_text(value).text
        if any(token in result[key].lower() for token in ("<thinking", "tool_call", "system prompt")):
            raise PreferenceContractError("snapshot contains a forbidden transcript category")
    return result


def _send_signature(snapshot: dict[str, Any], feedback: str, selection: dict[str, Any]) -> str:
    return f"sha256:{stable_hash({'snapshot': snapshot, 'feedback': feedback, 'model_selection': selection})}"


def _job(job_id: str, request_id: str, feedback: str, group_id: str | None,
         snapshot: dict[str, Any], selection: dict[str, Any] | None, consent_revision: int) -> dict[str, Any]:
    now = utc_now()
    digest = f"sha256:{stable_hash(snapshot)}"
    state = "blocked_consent" if snapshot.get("storage_mode") == "local_only" else "blocked_model" if selection is None else "queued"
    error_code = "local_only" if state == "blocked_consent" else "model_unbound" if state == "blocked_model" else None
    return {
        "schema_version": 1, "job_id": job_id, "generation": 0, "request_id": request_id,
        "created_at": now, "updated_at": now,
        "state": state,
        "source_kind": "feedback",
        "feedback": feedback, "group_id": group_id, "snapshot_ref": job_id,
        "snapshot_digest": digest, "source_context": None, "model_selection": copy.deepcopy(selection),
        "consent_revision": consent_revision, "input_digest": f"sha256:{stable_hash({'snapshot': snapshot, 'feedback': feedback, 'selection': selection, 'consent': consent_revision})}",
        "attempts": 0, "next_attempt_at": None, "lease": None, "result_ref": None, "error_code": error_code,
        "usage": None,
    }


def _user_edit_job(job_id: str, request_id: str, source_context: dict[str, Any], group_id: str | None) -> dict[str, Any]:
    now = utc_now()
    feedback = source_context["reason"] or "用户在 Agent 完成后修改了文件；尚未提供修改原因。"
    return {
        "schema_version": 1,
        "job_id": job_id,
        "generation": 0,
        "request_id": request_id,
        "created_at": now,
        "updated_at": now,
        "state": "needs_review",
        "source_kind": "user_edit",
        "feedback": feedback,
        "group_id": group_id,
        "snapshot_ref": None,
        "snapshot_digest": None,
        "source_context": copy.deepcopy(source_context),
        "model_selection": None,
        "consent_revision": 0,
        "input_digest": f"sha256:{stable_hash({'source_context': source_context, 'group_id': group_id})}",
        "attempts": 0,
        "next_attempt_at": None,
        "lease": None,
        "result_ref": None,
        "error_code": "user_edit_needs_context",
        "usage": None,
    }


class FeedbackJobs:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.local = self.root / "local"
        self.jobs_path = self.local / "feedback-jobs.json"
        self.snapshot_dir = self.local / "feedback-snapshots"
        self.consent_path = self.local / "consent.json"
        self.state_path = self.local / "learning-state.json"
        self.worker_path = self.local / "worker.json"

    def _jobs(self) -> list[dict[str, Any]]:
        # Read paths must not create directories or otherwise mutate state.
        if not self.jobs_path.exists(): return []
        if self.jobs_path.is_symlink(): raise PreferenceIntegrityError("feedback jobs cannot be a symlink")
        value = json.loads(self.jobs_path.read_text(encoding="utf-8"))
        if not isinstance(value, list): raise PreferenceIntegrityError("feedback jobs must be a list")
        return [FeedbackJob.from_dict(item).to_dict() for item in value]

    def _state(self) -> dict[str, Any]:
        if not self.state_path.exists(): return {"schema_version": 1, "collection_revision": 0, "daily_date": None, "daily_requests": 0}
        if self.state_path.is_symlink(): raise PreferenceIntegrityError("learning state cannot be a symlink")
        try: state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc: raise PreferenceIntegrityError("learning state is unreadable") from exc
        if not isinstance(state, dict) or set(state) != {"schema_version", "collection_revision", "daily_date", "daily_requests"} or state.get("schema_version") != 1 or type(state.get("collection_revision")) is not int or state["collection_revision"] < 0 or (state["daily_date"] is not None and not isinstance(state["daily_date"], str)) or type(state["daily_requests"]) is not int or state["daily_requests"] < 0:
            raise PreferenceIntegrityError("learning state is invalid")
        return state

    def _collection_revision(self) -> int:
        return self._state()["collection_revision"]

    def _commit(self, writes: dict[Path, bytes | None]) -> None:
        # One short recoverable transaction covers every state transition. The
        # caller already owns data-root lock; no model I/O happens here.
        state = self._state(); state["collection_revision"] += 1
        writes = {**writes, self.state_path: (stable_json_dumps(state) + "\n").encode("utf-8")}
        transaction = PersistentTransaction.begin_local(self.root, writes)
        try:
            transaction.apply(); transaction.commit_local()
        except Exception:
            transaction.rollback()
            raise

    def _save(self, jobs: list[dict[str, Any]]) -> None:
        self._commit({self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8")})

    def _stop_job(self, jobs: list[dict[str, Any]], job: dict[str, Any], state: str, code: str) -> tuple[dict[str, Any], dict[str, Any]]:
        job.update({
            "generation": job["generation"] + 1,
            "updated_at": utc_now(),
            "state": state,
            "lease": None,
            "next_attempt_at": None,
            "error_code": code,
        })
        FeedbackJob.from_dict(job)
        worker = self._worker()
        writes: dict[Path, bytes | None] = {
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
        }
        if isinstance(worker, dict) and worker.get("job_id") == job["job_id"]:
            writes[self.worker_path] = None
        self._commit(writes)
        return {"job": copy.deepcopy(job), "blocked": state.startswith("blocked_")}, self._cas(jobs)

    @staticmethod
    def _current_model_status(config: Any, selection: dict[str, Any], stage: str = "extraction") -> tuple[bool, str, str | None]:
        provider = config.stage_provider(stage)
        if selection["max_tokens"] != provider["max_tokens"] or float(selection["timeout_seconds"]) != float(provider["timeout_seconds"]):
            return False, "the configured stage limits do not match the frozen selection", None
        configured_thinking = provider["thinking_level"]
        if configured_thinking != "inherit" and selection["thinking_level"] != configured_thinking:
            return False, "the configured stage thinking does not match the frozen selection", None
        if provider["name"] == "pi":
            if selection["provider_source"] != "pi" or selection["api_type"] != "pi":
                return False, "the configured Pi provider does not match the frozen selection", None
            return True, "Pi registry authorization is deferred until send", None
        ready, message = config.model_readiness(provider=provider)
        if not ready:
            return False, message, None
        if provider["name"] == "fake":
            if selection["provider_source"] != "fake" or selection["provider_id"] != "fake" or selection["model_id"] != provider["model"]:
                return False, "the configured fake model does not match the frozen selection", None
            endpoint = f"sha256:{hashlib.sha256(b'').hexdigest()}"
        else:
            if selection["provider_source"] != "custom" or selection["provider_id"] != "openai_compatible" or selection["model_id"] != provider["model"]:
                return False, "the configured custom model does not match the frozen selection", None
            endpoint = f"sha256:{hashlib.sha256(str(provider.get('base_url') or os.environ.get('OPENAI_BASE_URL') or '').encode()).hexdigest()}"
        if endpoint != selection["endpoint_fingerprint"]:
            return False, "the current model endpoint does not match the frozen selection", endpoint
        return True, "ready", endpoint

    def _snapshot_path(self, job_id: str) -> Path:
        return self.snapshot_dir / f"{_id(job_id, 'job_id')}.json"

    def _snapshot_bytes(self, snapshot: dict[str, Any]) -> bytes:
        return (stable_json_dumps(snapshot) + "\n").encode("utf-8")

    def _consent(self) -> dict[str, Any]:
        if not self.consent_path.exists() or self.consent_path.is_symlink():
            raise PreferenceContractError("no current model-send consent exists")
        try: value = json.loads(self.consent_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc: raise PreferenceIntegrityError("consent record is unreadable") from exc
        data = _strict(value, {"schema_version", "revision", "allowed", "authorizations"}, "consent")
        if (data["schema_version"] != 1 or type(data["revision"]) is not int or data["revision"] < 1
                or not isinstance(data["allowed"], bool) or not isinstance(data["authorizations"], list)
                or len(data["authorizations"]) > 256):
            raise PreferenceContractError("consent record is invalid")
        authorizations: list[dict[str, Any]] = []
        revisions: set[int] = set()
        for raw in data["authorizations"]:
            item = _strict(raw, {"revision", "scope", "input_signature", "model_selection", "consumed_by"}, "feedback authorization entry")
            if (type(item["revision"]) is not int or item["revision"] < 1 or item["revision"] > data["revision"]
                    or item["revision"] in revisions or item["scope"] != "single"
                    or not isinstance(item["input_signature"], str) or not item["input_signature"].startswith("sha256:")):
                raise PreferenceContractError("feedback authorization entry is invalid")
            revisions.add(item["revision"])
            item["model_selection"] = _selection(item["model_selection"])
            if item["consumed_by"] is not None:
                _id(item["consumed_by"], "feedback authorization consumed_by")
            authorizations.append(item)
        if not data["allowed"] and authorizations:
            raise PreferenceContractError("revoked feedback consent cannot retain authorizations")
        data["authorizations"] = authorizations
        return data

    def _authorization(
        self,
        revision: int,
        signature: str,
        selection: dict[str, Any],
        *,
        consumed_by: str | None,
    ) -> dict[str, Any] | None:
        try:
            consent = self._consent()
        except PreferenceError:
            return None
        if not consent["allowed"]:
            return None
        return next((item for item in consent["authorizations"] if item["revision"] == revision
                     and item["input_signature"] == signature and item["model_selection"] == selection
                     and item["consumed_by"] == consumed_by), None)

    def _consume_authorization(
        self,
        revision: int,
        signature: str,
        selection: dict[str, Any],
        job_id: str,
    ) -> dict[str, Any]:
        consent = self._consent()
        if not consent["allowed"]:
            raise PreferenceContractError("feedback authorization was revoked")
        entry = next((item for item in consent["authorizations"] if item["revision"] == revision
                      and item["input_signature"] == signature and item["model_selection"] == selection), None)
        if entry is None or entry["consumed_by"] not in {None, job_id}:
            raise PreferenceContractError("feedback authorization is missing or already consumed")
        entry["consumed_by"] = job_id
        return consent

    @staticmethod
    def send_signature(snapshot: Any, feedback: Any, selection: Any) -> str:
        checked_snapshot = _snapshot(snapshot)
        if not isinstance(feedback, str) or not feedback.strip() or len(feedback) > _MAX_FEEDBACK:
            raise PreferenceContractError("feedback must be a non-empty bounded string")
        return _send_signature(checked_snapshot, sanitize_text(feedback).text, _selection(selection))

    def preview(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"feedback", "snapshot", "model_selection"}, "feedback send preview")
        snapshot = _snapshot(data["snapshot"])
        if snapshot["storage_mode"] != "ask":
            raise PreferenceContractError("only ask-mode feedback has a send preview")
        selection = _selection(data["model_selection"])
        signature = self.send_signature(snapshot, data["feedback"], selection)
        return {
            "input_signature": signature,
            "model_selection": selection,
            "send_preview": {"feedback": sanitize_text(data["feedback"]).text, "snapshot": snapshot},
        }, self._cas(self._jobs())

    def authorize(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"revision", "allowed", "scope", "input_signature", "model_selection"}, "feedback authorization")
        if (type(data["revision"]) is not int or data["revision"] < 1 or not isinstance(data["allowed"], bool)
                or data["scope"] != "single" or not isinstance(data["input_signature"], str)
                or not data["input_signature"].startswith("sha256:")):
            raise PreferenceContractError("feedback authorization is invalid")
        selection = _selection(data["model_selection"])
        previous = self._consent() if self.consent_path.exists() else None
        entry = {"revision": data["revision"], "scope": "single", "input_signature": data["input_signature"], "model_selection": selection, "consumed_by": None}
        if previous is not None:
            if data["revision"] < previous["revision"]:
                raise PreferenceContractError("consent revision must be monotonic")
            existing = next((item for item in previous["authorizations"] if item["revision"] == data["revision"]), None)
            if data["revision"] == previous["revision"]:
                same_entry = existing is not None and all(existing[key] == entry[key] for key in ("revision", "scope", "input_signature", "model_selection"))
                if data["allowed"] != previous["allowed"] or (data["allowed"] and not same_entry):
                    raise PreferenceContractError("consent revision conflicts with the existing authorization")
                return {"consent": previous, "idempotent": True}, self._cas(self._jobs())
        authorizations = [] if not data["allowed"] else ([*previous["authorizations"]] if previous and previous["allowed"] else [])
        if data["allowed"]:
            authorizations.append(entry)
            if len(authorizations) > 256:
                raise PreferenceContractError("feedback authorization set exceeds its bounded limit")
        consent = {"schema_version": 1, "revision": data["revision"], "allowed": data["allowed"], "authorizations": authorizations}
        self._commit({self.consent_path: (stable_json_dumps(consent) + "\n").encode("utf-8")})
        return {"consent": consent}, self._cas(self._jobs())

    def _load_snapshot(self, job: dict[str, Any]) -> dict[str, Any]:
        path = self._snapshot_path(job["snapshot_ref"])
        if path.is_symlink() or not path.is_file(): raise PreferenceIntegrityError("feedback snapshot is missing")
        snapshot = _snapshot(json.loads(path.read_text(encoding="utf-8")))
        if f"sha256:{stable_hash(snapshot)}" != job["snapshot_digest"]:
            raise PreferenceIntegrityError("feedback snapshot digest does not match its job")
        return snapshot

    def _cas(self, jobs: list[dict[str, Any]]) -> dict[str, Any]:
        return cas_for("feedback-jobs", self._collection_revision(), jobs).to_dict()

    def create(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"feedback", "group_id", "snapshot", "model_selection", "consent_revision"}, "feedback create")
        feedback = data["feedback"]
        if not isinstance(feedback, str) or not feedback.strip() or len(feedback) > _MAX_FEEDBACK:
            raise PreferenceContractError("feedback must be a non-empty bounded string")
        feedback = sanitize_text(feedback).text
        group_id = data["group_id"]
        if group_id is None:
            raise PreferenceContractError("feedback group_id is required")
        _id(group_id, "group_id")
        from .store import PreferenceStore
        if group_id not in {item.id for item in PreferenceStore(self.root).read_groups_v2()}:
            raise PreferenceContractError("feedback group_id does not identify an existing group")
        if type(data["consent_revision"]) is not int or data["consent_revision"] < 0:
            raise PreferenceContractError("consent_revision must be a non-negative integer")
        snapshot = _snapshot(data["snapshot"])
        selection = None if data["model_selection"] is None else _selection(data["model_selection"])
        signature = _send_signature(snapshot, feedback, selection) if snapshot["storage_mode"] == "ask" and selection is not None else None
        if selection is None and data["consent_revision"] != 0:
            raise PreferenceContractError("unbound feedback must use consent_revision=0")
        checked_request_id = _id(request_id, "request_id")
        probe = _job("feedback-probe", checked_request_id, feedback, group_id, snapshot, selection, data["consent_revision"])
        jobs = self._jobs()
        for existing in jobs:
            if existing["request_id"] == checked_request_id:
                if existing["input_digest"] != probe["input_digest"]:
                    raise PreferenceContractError("request_id was already used with different feedback input")
                return {"job": copy.deepcopy(existing), "idempotent": True}, self._cas(jobs)
        if signature is not None and selection is not None and self._authorization(
            data["consent_revision"], signature, selection, consumed_by=None,
        ) is None:
            raise PreferenceContractError("feedback authorization does not match frozen input and model selection")
        job_id = new_id("feedback-")
        consent = self._consume_authorization(data["consent_revision"], signature, selection, job_id) if signature is not None and selection is not None else None
        job = _job(job_id, checked_request_id, feedback, group_id, snapshot, selection, data["consent_revision"])
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        if job["state"] == "queued" and (not config.enabled or not config.stage_enabled("extraction")):
            job.update({"state": "blocked_config", "error_code": "extraction_disabled"})
        FeedbackJob.from_dict(job)
        jobs.append(job)
        self._commit({
            self._snapshot_path(job_id): self._snapshot_bytes(snapshot),
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
            **({self.consent_path: (stable_json_dumps(consent) + "\n").encode("utf-8")} if consent is not None else {}),
        })
        return {"job": FeedbackJob.from_dict(job).to_dict()}, self._cas(jobs)

    def create_user_edit(self, request_id: str, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"task_key", "task_summary", "paths", "diffs", "reason", "group_id"}, "user edit create")
        task_key = _id(data["task_key"], "task_key")
        task_summary = data["task_summary"]
        if not isinstance(task_summary, str) or not task_summary.strip() or len(task_summary) > 1000:
            raise PreferenceContractError("user edit task_summary must be bounded")
        task_summary = sanitize_text(task_summary).text
        if not isinstance(data["paths"], list) or not data["paths"] or len(data["paths"]) > 32:
            raise PreferenceContractError("user edit paths must contain one to 32 paths")
        paths = [safe_relative_project_path(item) for item in data["paths"]]
        if len(paths) != len(set(paths)):
            raise PreferenceContractError("user edit paths must not contain duplicates")
        if any(path_is_denied(path, DEFAULT_DENIED_FILE_NAMES) for path in paths):
            raise PreferenceIntegrityError("credential paths are not allowed in user edit evidence")
        if not isinstance(data["diffs"], dict) or set(data["diffs"]) - set(paths):
            raise PreferenceContractError("user edit diffs must be keyed by selected paths")
        diffs: dict[str, str] = {}
        for path, raw_diff in data["diffs"].items():
            if not isinstance(raw_diff, str) or len(raw_diff.encode("utf-8")) > 32 * 1024:
                raise PreferenceContractError("user edit diff is invalid")
            cleaned = sanitize_text(raw_diff).text
            if cleaned.strip():
                diffs[path] = cleaned
        reason = data["reason"]
        if reason is not None:
            if not isinstance(reason, str) or not reason.strip() or len(reason) > _MAX_FEEDBACK:
                raise PreferenceContractError("user edit reason must be a bounded string or null")
            reason = sanitize_text(reason).text
        group_id = data["group_id"]
        if group_id is not None:
            _id(group_id, "group_id")
            from .store import PreferenceStore
            if group_id not in {item.id for item in PreferenceStore(self.root).read_groups_v2()}:
                raise PreferenceContractError("user edit group_id does not identify an existing group")
        source_context = {
            "task_key": task_key,
            "task_summary": task_summary,
            "paths": paths,
            "diffs": diffs,
            "reason": reason,
        }
        checked_request_id = _id(request_id, "request_id")
        probe = _user_edit_job("feedback-probe", checked_request_id, source_context, group_id)
        jobs = self._jobs()
        for existing in jobs:
            if existing["request_id"] == checked_request_id:
                if existing["input_digest"] != probe["input_digest"]:
                    raise PreferenceContractError("request_id was already used with different user edit input")
                return {"job": copy.deepcopy(existing), "idempotent": True}, self._cas(jobs)
        job = _user_edit_job(new_id("feedback-"), checked_request_id, source_context, group_id)
        FeedbackJob.from_dict(job)
        jobs.append(job)
        self._save(jobs)
        return {"job": copy.deepcopy(job)}, self._cas(jobs)

    def list(self) -> tuple[dict[str, Any], dict[str, Any]]:
        jobs = self._jobs()
        return {"jobs": jobs}, self._cas(jobs)

    def sweep(self) -> tuple[dict[str, Any], dict[str, Any]]:
        """Recover expired leases, retry waits, and bounded snapshot TTLs."""
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        jobs = self._jobs(); changed = 0; now = _now()
        delete_snapshots: list[Path] = []
        for job in jobs:
            lease = job.get("lease")
            if job["state"] == "running" and isinstance(lease, dict) and _parse_time(lease["expires_at"]) <= now:
                retry = job["attempts"] < config.learning["max_attempts"]
                job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "retry_wait" if retry else "failed", "lease": None, "next_attempt_at": _iso_after(30) if retry else None, "error_code": "lease_expired"}); changed += 1
            created = _parse_time(job["created_at"])
            if job["snapshot_ref"] is not None and created + timedelta(days=config.privacy["snapshot_retention_days"]) <= now and job["state"] in {"queued", "retry_wait", "completed", "needs_review", "failed", "cancelled", "blocked_config", "blocked_model", "blocked_consent", "blocked_budget"}:
                delete_snapshots.append(self._snapshot_path(job["snapshot_ref"]))
                job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "needs_review", "snapshot_ref": None, "snapshot_digest": None, "error_code": "snapshot_expired"}); changed += 1
        worker = self._worker()
        writes: dict[Path, bytes | None] = {}
        if changed: writes[self.jobs_path] = (stable_json_dumps(jobs) + "\n").encode("utf-8")
        for path in delete_snapshots: writes[path] = None
        if worker is not None and _parse_time(worker["expires_at"]) <= now: writes[self.worker_path] = None; changed += 1
        if writes: self._commit(writes)
        return {"recovered": changed, "jobs": jobs}, self._cas(jobs)

    def get(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id"}, "feedback get")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        snapshot = self._load_snapshot(job) if job["snapshot_ref"] is not None else None
        return {"job": copy.deepcopy(job), "snapshot": snapshot}, self._cas(jobs)

    def cancel(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation"}, "feedback cancel")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if job["state"] == "cancelled":
            return {"job": copy.deepcopy(job), "idempotent": True}, self._cas(jobs)
        if data["generation"] != job["generation"]: raise PreferenceContractError("feedback job generation conflict")
        if job["state"] in {"completed", "needs_review"}: raise PreferenceContractError("feedback job cannot be cancelled")
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "cancelled", "lease": None, "next_attempt_at": None, "error_code": "cancelled"})
        FeedbackJob.from_dict(job)
        worker = self._worker()
        writes: dict[Path, bytes | None] = {self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8")}
        if isinstance(worker, dict) and worker.get("job_id") == job["job_id"]:
            writes[self.worker_path] = None
        self._commit(writes)
        return {"job": copy.deepcopy(job)}, self._cas(jobs)

    def _find(self, jobs: list[dict[str, Any]], job_id: Any) -> dict[str, Any]:
        checked = _id(job_id, "job_id")
        for job in jobs:
            if job["job_id"] == checked: return job
        raise PreferenceContractError("feedback job does not exist")

    def edit(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        if not isinstance(payload, dict) or set(payload) not in ({"job_id", "generation", "feedback"}, {"job_id", "generation", "feedback", "snapshot"}):
            raise PreferenceContractError("feedback update has an invalid schema")
        data = dict(payload)
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if data["generation"] != job["generation"]: raise PreferenceContractError("feedback job generation conflict")
        worker = self._worker()
        feedback = data["feedback"]
        if not isinstance(feedback, str) or not feedback.strip() or len(feedback) > _MAX_FEEDBACK: raise PreferenceContractError("feedback must be bounded")
        feedback = sanitize_text(feedback).text
        if job["source_kind"] == "user_edit":
            source_context = copy.deepcopy(job["source_context"])
            source_context["reason"] = feedback
            job.update({
                "feedback": feedback,
                "source_context": source_context,
                "input_digest": f"sha256:{stable_hash({'source_context': source_context, 'group_id': job['group_id']})}",
                "generation": job["generation"] + 1,
                "updated_at": utc_now(),
                "error_code": "user_edit_needs_context",
            })
            FeedbackJob.from_dict(job)
            self._save(jobs)
            return {"job": copy.deepcopy(job)}, self._cas(jobs)
        invalidation, evidence_writes = EvidenceStore(self.root).prepare_feedback_invalidation(job["job_id"])
        if job["result_ref"] is not None and not invalidation["invalidated"]:
            raise PreferenceIntegrityError("feedback result_ref does not identify its derived evidence")
        snapshot = _snapshot(data["snapshot"]) if "snapshot" in data else self._load_snapshot(job)
        state = "blocked_consent" if snapshot["storage_mode"] == "local_only" or job["model_selection"] is not None else "blocked_model"
        error_code = "local_only" if snapshot["storage_mode"] == "local_only" else "input_changed_requires_authorization" if job["model_selection"] is not None else "model_unbound"
        job.update({"feedback": feedback, "snapshot_digest": f"sha256:{stable_hash(snapshot)}",
                    "input_digest": f"sha256:{stable_hash({'snapshot': snapshot, 'feedback': feedback, 'selection': job['model_selection'], 'consent': job['consent_revision']})}",
                    "generation": job["generation"] + 1, "updated_at": utc_now(), "state": state, "lease": None,
                    "result_ref": None, "error_code": error_code, "next_attempt_at": None})
        FeedbackJob.from_dict(job)
        writes: dict[Path, bytes | None] = {
            **evidence_writes,
            self._snapshot_path(job["job_id"]): self._snapshot_bytes(snapshot),
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
        }
        if isinstance(worker, dict) and worker.get("job_id") == job["job_id"]:
            writes[self.worker_path] = None
        self._commit(writes)
        return {"job": copy.deepcopy(job), "evidence_invalidation": invalidation}, self._cas(jobs)

    def update_user_edit(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation", "reason", "group_id", "paths"}, "user edit update")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if data["generation"] != job["generation"]:
            raise PreferenceContractError("feedback job generation conflict")
        if job["source_kind"] != "user_edit":
            raise PreferenceContractError("feedback job is not a user-edit record")
        reason = data["reason"]
        if not isinstance(reason, str) or not reason.strip() or len(reason) > _MAX_FEEDBACK:
            raise PreferenceContractError("user edit reason must be a bounded string")
        reason = sanitize_text(reason).text
        group_id = _id(data["group_id"], "group_id")
        from .store import PreferenceStore
        if group_id not in {item.id for item in PreferenceStore(self.root).read_groups_v2()}:
            raise PreferenceContractError("user edit group_id does not identify an existing group")
        source_context = copy.deepcopy(job["source_context"])
        selected = data["paths"]
        if not isinstance(selected, list) or not selected:
            raise PreferenceContractError("user edit update requires at least one selected path")
        selected_paths = [safe_relative_project_path(item) for item in selected]
        if len(selected_paths) != len(set(selected_paths)) or not set(selected_paths) <= set(source_context["paths"]):
            raise PreferenceContractError("user edit selected paths are invalid")
        source_context["paths"] = selected_paths
        source_context["diffs"] = {
            path: source_context["diffs"][path]
            for path in selected_paths if path in source_context["diffs"]
        }
        source_context["reason"] = reason
        job.update({
            "feedback": reason,
            "group_id": group_id,
            "source_context": source_context,
            "input_digest": f"sha256:{stable_hash({'source_context': source_context, 'group_id': group_id})}",
            "generation": job["generation"] + 1,
            "updated_at": utc_now(),
            "error_code": "user_edit_weak_evidence",
        })
        FeedbackJob.from_dict(job)
        self._save(jobs)
        return {"job": copy.deepcopy(job)}, self._cas(jobs)

    def delete(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation"}, "feedback delete")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if data["generation"] != job["generation"]: raise PreferenceContractError("feedback job generation conflict")
        if job["state"] == "running": raise PreferenceContractError("running feedback must be cancelled before deletion")
        invalidation, evidence_writes = EvidenceStore(self.root).prepare_feedback_invalidation(job["job_id"])
        if job["result_ref"] is not None and not invalidation["invalidated"]:
            raise PreferenceIntegrityError("feedback result_ref does not identify its derived evidence")
        jobs.remove(job)
        worker = self._worker()
        writes: dict[Path, bytes | None] = {
            **evidence_writes,
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
            self._snapshot_path(job["job_id"]): None,
        }
        if isinstance(worker, dict) and worker.get("job_id") == job["job_id"]:
            writes[self.worker_path] = None
        self._commit(writes)
        return {"deleted": job["job_id"], "evidence_invalidation": invalidation}, self._cas(jobs)

    def retry(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation"}, "feedback retry")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if data["generation"] != job["generation"]: raise PreferenceContractError("feedback job generation conflict")
        if job["state"] not in {"failed", "blocked_config", "blocked_model", "blocked_budget", "retry_wait", "cancelled"}:
            raise PreferenceContractError("feedback job is not retryable")
        if job["model_selection"] is None:
            raise PreferenceContractError("feedback job must be explicitly bound to a model before retry")
        snapshot = self._load_snapshot(job)
        if snapshot["storage_mode"] == "local_only":
            raise PreferenceContractError("local-only feedback must be explicitly authorized and bound before retry")
        job.update({"state": "queued", "lease": None, "next_attempt_at": None, "error_code": None, "generation": job["generation"] + 1, "updated_at": utc_now()})
        FeedbackJob.from_dict(job); self._save(jobs); return {"job": copy.deepcopy(job)}, self._cas(jobs)

    def bind(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation", "model_selection", "consent_revision"}, "feedback bind")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if data["generation"] != job["generation"]: raise PreferenceContractError("feedback job generation conflict")
        if job["state"] not in {"blocked_model", "blocked_consent", "blocked_config", "failed", "cancelled"}:
            raise PreferenceContractError("feedback job is not available for model binding")
        selection = _selection(data["model_selection"])
        if type(data["consent_revision"]) is not int or data["consent_revision"] < 1:
            raise PreferenceContractError("feedback binding requires a positive consent revision")
        snapshot = self._load_snapshot(job)
        signature = _send_signature({**snapshot, "storage_mode": "ask"}, job["feedback"], selection)
        if self._authorization(data["consent_revision"], signature, selection, consumed_by=None) is None:
            raise PreferenceContractError("feedback binding authorization does not match the selected input")
        consent = self._consume_authorization(data["consent_revision"], signature, selection, job["job_id"])
        snapshot["storage_mode"] = "ask"
        feedback = job["feedback"]
        job.update({
            "model_selection": selection,
            "consent_revision": data["consent_revision"],
            "snapshot_digest": f"sha256:{stable_hash(snapshot)}",
            "input_digest": f"sha256:{stable_hash({'snapshot': snapshot, 'feedback': feedback, 'selection': selection, 'consent': data['consent_revision']})}",
            "generation": job["generation"] + 1,
            "updated_at": utc_now(),
            "state": "queued",
            "attempts": 0,
            "lease": None,
            "next_attempt_at": None,
            "error_code": None,
        })
        FeedbackJob.from_dict(job)
        self._commit({
            self._snapshot_path(job["job_id"]): self._snapshot_bytes(snapshot),
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
            self.consent_path: (stable_json_dumps(consent) + "\n").encode("utf-8"),
        })
        return {"job": copy.deepcopy(job)}, self._cas(jobs)

    def reject_dispatch(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "generation", "input_digest", "model_selection", "consent_revision", "claim_error_code"}, "learning job dispatch rejection")
        claim_error_code = data["claim_error_code"]
        if claim_error_code not in _PERMANENT_DISPATCH_ERRORS:
            raise PreferenceContractError("claim error is not eligible for durable dispatch rejection")
        if type(data["generation"]) is not int or data["generation"] < 0 or type(data["consent_revision"]) is not int or data["consent_revision"] < 0:
            raise PreferenceContractError("dispatch rejection generations are invalid")
        if not isinstance(data["input_digest"], str):
            raise PreferenceContractError("dispatch rejection input digest is invalid")
        selection = _selection(data["model_selection"])
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if job["state"] not in {"queued", "retry_wait"}:
            raise PreferenceConflictError("feedback job changed before dispatch rejection")
        if (data["generation"] != job["generation"] or data["input_digest"] != job["input_digest"]
                or selection != job["model_selection"] or data["consent_revision"] != job["consent_revision"]):
            raise PreferenceConflictError("feedback job input changed before dispatch rejection")
        return self._stop_job(jobs, job, "failed", _PERMANENT_DISPATCH_ERRORS[claim_error_code])

    def _worker(self) -> dict[str, Any] | None:
        if not self.worker_path.exists(): return None
        if self.worker_path.is_symlink(): raise PreferenceIntegrityError("worker lease cannot be a symlink")
        try: value = json.loads(self.worker_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc: raise PreferenceIntegrityError("worker lease is unreadable") from exc
        data = _strict(value, {"schema_version", "owner_id", "token", "job_id", "generation", "expires_at", "renewed_at"}, "worker lease")
        if data["schema_version"] != 1: raise PreferenceIntegrityError("worker lease is invalid")
        _id(data["owner_id"], "worker.owner_id"); _id(data["token"], "worker.token"); _id(data["job_id"], "worker.job_id")
        if type(data["generation"]) is not int or data["generation"] < 0: raise PreferenceIntegrityError("worker.generation is invalid")
        _parse_time(data["expires_at"]); _parse_time(data["renewed_at"])
        return data

    def claim(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "owner_id", "consent_revision", "model_selection", "lease_seconds"}, "learning job claim")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"]); selection = _selection(data["model_selection"])
        if job["state"] not in {"queued", "retry_wait"}:
            raise PreferenceContractError("feedback job is not available")
        if job["next_attempt_at"] is not None and _parse_time(job["next_attempt_at"]) > _now():
            raise PreferenceContractError("feedback job is waiting for retry backoff", code="retry_not_due", retryable=True)
        if type(data["lease_seconds"]) is not int or not 5 <= data["lease_seconds"] <= 900:
            raise PreferenceContractError("lease_seconds must be 5..900")
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        if not config.enabled or not config.stage_enabled("extraction"):
            return self._stop_job(jobs, job, "blocked_config", "extraction_disabled")
        if job["model_selection"] is None:
            return self._stop_job(jobs, job, "blocked_model", "model_unbound")
        ready, _readiness, _endpoint = self._current_model_status(config, selection)
        if not ready:
            return self._stop_job(jobs, job, "blocked_model", "model_unavailable")
        if data["consent_revision"] != job["consent_revision"] or selection != job["model_selection"]:
            return self._stop_job(jobs, job, "blocked_consent", "frozen_model_changed")
        if job["attempts"] >= config.learning["max_attempts"]:
            return self._stop_job(jobs, job, "failed", "max_attempts_exceeded")
        worker = self._worker(); owner = _id(data["owner_id"], "owner_id")
        if worker is not None and _parse_time(worker["expires_at"]) > _now() and (worker["owner_id"] != owner or worker["job_id"] != job["job_id"]):
            raise PreferenceContractError("another feedback worker currently owns this data root", code="worker_busy", retryable=True)
        state = self._state(); today = _now().date().isoformat()
        requests = state["daily_requests"] if state["daily_date"] == today else 0
        if requests >= config.learning["max_requests_per_day"]:
            return self._stop_job(jobs, job, "blocked_budget", "daily_budget_exhausted")
        try:
            snapshot = self._load_snapshot(job)
        except PreferenceError:
            return self._stop_job(jobs, job, "failed", "snapshot_invalid")
        if snapshot["storage_mode"] == "local_only":
            return self._stop_job(jobs, job, "blocked_consent", "local_only")
        signature = _send_signature(snapshot, job["feedback"], job["model_selection"])
        if self._authorization(job["consent_revision"], signature, job["model_selection"], consumed_by=job["job_id"]) is None:
            return self._stop_job(jobs, job, "blocked_consent", "consent_revoked")
        job["generation"] += 1
        job.update({"state": "running", "attempts": job["attempts"] + 1, "updated_at": utc_now(),
                    "lease": {"token": f"lease-{secrets.token_hex(24)}", "owner_id": owner, "job_id": job["job_id"], "generation": job["generation"], "expires_at": _iso_after(data["lease_seconds"]), "renewed_at": utc_now()}, "error_code": None})
        FeedbackJob.from_dict(job)
        worker_content = {
            "schema_version": 1,
            "owner_id": owner,
            "token": job["lease"]["token"],
            "job_id": job["job_id"],
            "generation": job["generation"],
            "expires_at": job["lease"]["expires_at"],
            "renewed_at": job["lease"]["renewed_at"],
        }
        # Persist worker ownership and running job in the same recoverable commit.
        state["daily_date"] = today; state["daily_requests"] = requests + 1
        state["collection_revision"] += 1
        writes = {self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"), self.worker_path: (stable_json_dumps(worker_content) + "\n").encode("utf-8"), self.state_path: (stable_json_dumps(state) + "\n").encode("utf-8")}
        transaction = PersistentTransaction.begin_local(self.root, writes)
        try: transaction.apply(); transaction.commit_local()
        except Exception: transaction.rollback(); raise
        from .store import PreferenceStore
        groups = [item.to_dict() for item in PreferenceStore(self.root).read_groups_v2()]
        return {"job": copy.deepcopy(job), "prompt": extraction_prompt(snapshot, groups, explicit_group_id=job["group_id"], feedback=job["feedback"])}, self._cas(jobs)

    def authorize_send(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token", "model_selection", "consent_revision", "endpoint_fingerprint"}, "learning job send authorization")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"]); selection = _selection(data["model_selection"])
        lease = job.get("lease"); worker = self._worker()
        if (job["state"] != "running" or not isinstance(lease, dict) or lease.get("token") != data["token"]
                or _parse_time(lease["expires_at"]) <= _now() or not isinstance(worker, dict)
                or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]
                or _parse_time(worker["expires_at"]) <= _now()):
            raise PreferenceContractError("feedback lease is no longer valid")
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        if not config.enabled or not config.stage_enabled("extraction"):
            return self._stop_job(jobs, job, "blocked_config", "extraction_disabled")
        if data["consent_revision"] != job["consent_revision"] or selection != job["model_selection"]:
            return self._stop_job(jobs, job, "blocked_consent", "frozen_model_changed")
        snapshot = self._load_snapshot(job)
        signature = _send_signature(snapshot, job["feedback"], selection)
        if self._authorization(job["consent_revision"], signature, selection, consumed_by=job["job_id"]) is None:
            return self._stop_job(jobs, job, "blocked_consent", "consent_revoked")
        ready, _readiness, current_endpoint = self._current_model_status(config, selection)
        endpoint_matches = data["endpoint_fingerprint"] == selection["endpoint_fingerprint"]
        if config.provider["name"] != "pi":
            endpoint_matches = endpoint_matches and current_endpoint == selection["endpoint_fingerprint"]
        if not ready or not endpoint_matches:
            return self._stop_job(jobs, job, "blocked_model", "endpoint_changed")
        return {"job": copy.deepcopy(job), "authorized": True}, self._cas(jobs)

    def renew(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token", "lease_seconds"}, "learning job renew")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"]); lease = job["lease"]
        if job["state"] != "running" or not isinstance(lease, dict) or lease.get("token") != data["token"] or _parse_time(lease["expires_at"]) <= _now(): raise PreferenceContractError("feedback lease is no longer valid")
        if type(data["lease_seconds"]) is not int or not 5 <= data["lease_seconds"] <= 900: raise PreferenceContractError("lease_seconds must be 5..900")
        worker = self._worker()
        if not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("feedback root worker lease is no longer valid")
        job["generation"] += 1
        lease.update({"generation": job["generation"], "expires_at": _iso_after(data["lease_seconds"]), "renewed_at": utc_now()})
        job["updated_at"] = utc_now()
        worker.update({"generation": job["generation"], "expires_at": lease["expires_at"], "renewed_at": lease["renewed_at"]})
        FeedbackJob.from_dict(job)
        self._commit({self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"), self.worker_path: (stable_json_dumps(worker) + "\n").encode("utf-8")})
        return {"job": copy.deepcopy(job)}, self._cas(jobs)

    def _complete_evidence_blocked(
        self,
        jobs: list[dict[str, Any]],
        job: dict[str, Any],
        error_code: str,
        result_flag: str,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        job.update({
            "generation": job["generation"] + 1,
            "updated_at": utc_now(),
            "state": "needs_review",
            "lease": None,
            "next_attempt_at": None,
            "result_ref": None,
            "error_code": error_code,
        })
        FeedbackJob.from_dict(job)
        self._commit({
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
            self.worker_path: None,
        })
        return {"job": copy.deepcopy(job), result_flag: True}, self._cas(jobs)

    def complete(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        required = {"job_id", "token", "input_digest", "model_selection", "consent_revision", "output"}
        if not isinstance(payload, dict) or set(payload) not in {frozenset(required), frozenset({*required, "usage"})}:
            raise PreferenceContractError("model call completion has an invalid schema")
        data = dict(payload)
        jobs = self._jobs(); job = self._find(jobs, data["job_id"]); lease = job["lease"]
        selection = _selection(data["model_selection"])
        usage = model_usage(data["usage"], selection) if "usage" in data else {
            "known": False, "input_tokens": None, "output_tokens": None, "total_tokens": None,
            "cost_usd": None, "cost_status": "unknown", "provider_id": selection["provider_id"],
            "model_id": selection["model_id"], "max_tokens": selection["max_tokens"],
        }
        if (job["state"] != "running" or not isinstance(lease, dict) or lease.get("token") != data["token"]
                or _parse_time(lease["expires_at"]) <= _now() or data["input_digest"] != job["input_digest"]
                or data["consent_revision"] != job["consent_revision"] or selection != job["model_selection"]):
            raise PreferenceContractError("feedback result does not match its active lease and frozen input")
        worker = self._worker()
        if not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("feedback root worker lease is no longer valid")
        from .config import PreferenceConfig
        config = PreferenceConfig.load(self.root)
        if not config.enabled or not config.stage_enabled("extraction"):
            return self._stop_job(jobs, job, "blocked_config", "extraction_disabled")
        ready, _readiness, current_endpoint = self._current_model_status(config, selection)
        snapshot = self._load_snapshot(job)
        signature = _send_signature(snapshot, job["feedback"], job["model_selection"])
        if self._authorization(job["consent_revision"], signature, job["model_selection"], consumed_by=job["job_id"]) is None:
            return self._stop_job(jobs, job, "blocked_consent", "consent_revoked")
        if not ready or (config.stage_provider("extraction")["name"] != "pi" and current_endpoint != selection["endpoint_fingerprint"]):
            return self._stop_job(jobs, job, "blocked_model", "endpoint_changed")
        snapshot = self._load_snapshot(job)
        from .store import PreferenceStore
        groups = [item.to_dict() for item in PreferenceStore(self.root).read_groups_v2()]
        extracted = parse_extraction(data["output"], snapshot, groups, explicit_group_id=job["group_id"], feedback=job["feedback"])
        if extracted.get("group_id") != job["group_id"]:
            raise PreferenceContractError("extracted evidence group does not match the job")
        try:
            revision, evidence_writes = EvidenceStore(self.root).prepare_extracted_revision(
                job,
                snapshot,
                extracted,
                sanitizer_version=SANITIZER_VERSION,
                extractor_prompt_version=EXTRACTOR_PROMPT_VERSION,
            )
        except EvidenceWithdrawnError:
            return self._complete_evidence_blocked(jobs, job, "evidence_withdrawn", "evidence_withdrawn")
        except PreferenceConflictError:
            return self._complete_evidence_blocked(jobs, job, "evidence_conflict", "evidence_conflict")
        except PreferenceIntegrityError:
            return self._complete_evidence_blocked(jobs, job, "evidence_invalid", "evidence_invalid")
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "needs_review", "lease": None, "result_ref": revision["revision_id"], "error_code": None, "usage": usage})
        FeedbackJob.from_dict(job)
        self._commit({
            **evidence_writes,
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
            self.worker_path: None,
        })
        return {"job": copy.deepcopy(job), "evidence_revision": revision}, self._cas(jobs)

    def cancel_lease(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token"}, "learning job cancel")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"]); lease = job.get("lease")
        worker = self._worker()
        if job["state"] != "running" or not isinstance(lease, dict) or lease.get("token") != data["token"] or not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("feedback lease is no longer valid")
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "cancelled", "lease": None, "next_attempt_at": None, "error_code": "cancelled"})
        FeedbackJob.from_dict(job)
        self._commit({self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"), self.worker_path: None})
        return {"job": copy.deepcopy(job)}, self._cas(jobs)

    def prepare_evidence_restore(self, feedback_id: str | None) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        if feedback_id is None:
            return {"requeued_feedback_jobs": []}, {}
        checked = _id(feedback_id, "feedback_id")
        jobs = self._jobs()
        affected = [
            job for job in jobs
            if job["job_id"] == checked
            and job["state"] == "needs_review"
            and job["error_code"] == "evidence_withdrawn"
            and job["result_ref"] is None
            and job["snapshot_ref"] is not None
            and job["model_selection"] is not None
        ]
        if not affected:
            return {"requeued_feedback_jobs": []}, {}
        for job in affected:
            job.update({
                "generation": job["generation"] + 1,
                "updated_at": utc_now(),
                "state": "queued",
                "lease": None,
                "next_attempt_at": None,
                "error_code": None,
            })
            FeedbackJob.from_dict(job)
        state = self._state()
        state["collection_revision"] += 1
        return {"requeued_feedback_jobs": [checked]}, {
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
            self.state_path: (stable_json_dumps(state) + "\n").encode("utf-8"),
        }

    def prepare_evidence_delete(self, revision_ids: set[str]) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        checked = {_id(item, "revision_id") for item in revision_ids}
        jobs = self._jobs()
        affected = [job for job in jobs if job["result_ref"] in checked]
        if not affected:
            return {"invalidated_feedback_jobs": []}, {}
        for job in affected:
            job.update({
                "generation": job["generation"] + 1,
                "updated_at": utc_now(),
                "state": "needs_review",
                "result_ref": None,
                "lease": None,
                "next_attempt_at": None,
                "error_code": "evidence_deleted",
            })
            FeedbackJob.from_dict(job)
        state = self._state()
        state["collection_revision"] += 1
        return {"invalidated_feedback_jobs": sorted(job["job_id"] for job in affected)}, {
            self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"),
            self.state_path: (stable_json_dumps(state) + "\n").encode("utf-8"),
        }

    def prepare_group_delete(self, group_id: str) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
        checked = _id(group_id, "group_id")
        jobs = self._jobs()
        removed = [job for job in jobs if job["group_id"] == checked]
        if not removed:
            return {"removed_feedback_jobs": []}, {}
        kept = [job for job in jobs if job["group_id"] != checked]
        writes: dict[Path, bytes | None] = {
            self.jobs_path: (stable_json_dumps(kept) + "\n").encode("utf-8"),
        }
        for job in removed:
            if job["snapshot_ref"] is not None:
                writes[self._snapshot_path(job["snapshot_ref"])] = None
        worker = self._worker()
        if isinstance(worker, dict) and any(job["job_id"] == worker.get("job_id") for job in removed):
            writes[self.worker_path] = None
        state = self._state()
        state["collection_revision"] += 1
        writes[self.state_path] = (stable_json_dumps(state) + "\n").encode("utf-8")
        return {"removed_feedback_jobs": sorted(job["job_id"] for job in removed)}, writes

    def fail(self, payload: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        data = _strict(payload, {"job_id", "token", "code"}, "learning job fail")
        jobs = self._jobs(); job = self._find(jobs, data["job_id"])
        if job["state"] != "running" or not isinstance(job["lease"], dict) or job["lease"].get("token") != data["token"]: raise PreferenceContractError("feedback lease is no longer valid")
        worker = self._worker()
        if not isinstance(worker, dict) or worker.get("token") != data["token"] or worker.get("job_id") != job["job_id"]:
            raise PreferenceContractError("feedback root worker lease is no longer valid")
        code = _id(data["code"], "code")
        from .config import PreferenceConfig
        retry = job["attempts"] < PreferenceConfig.load(self.root).learning["max_attempts"]
        job.update({"generation": job["generation"] + 1, "updated_at": utc_now(), "state": "retry_wait" if retry else "failed", "next_attempt_at": _iso_after(30) if retry else None, "lease": None, "error_code": code})
        FeedbackJob.from_dict(job)
        self._commit({self.jobs_path: (stable_json_dumps(jobs) + "\n").encode("utf-8"), self.worker_path: None})
        return {"job": copy.deepcopy(job)}, self._cas(jobs)
