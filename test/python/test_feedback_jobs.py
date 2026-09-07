from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import _support  # noqa: F401
from wikiskill_preference_core.config import PreferenceConfig
from wikiskill_preference_core.contracts import stable_json_dumps
from wikiskill_preference_core.evidence import EvidenceStore
from wikiskill_preference_core.errors import PreferenceConflictError, PreferenceContractError
from wikiskill_preference_core.jobs import FeedbackJobs
from wikiskill_preference_core.store import PreferenceStore


class FeedbackJobsTest(unittest.TestCase):
    def setUpRoot(self, root: Path) -> tuple[FeedbackJobs, str, dict[str, object]]:
        PreferenceStore.init(root)
        config_path = root / "config.json"
        config = json.loads(config_path.read_text())
        config["provider"] = {"name": "fake", "model": "fixture", "api_key_env": "PREFERENCE_MODEL_API_KEY", "thinking_level": "off", "max_tokens": 128, "timeout_seconds": 10}
        config["learning"]["extraction"]["enabled"] = True
        config_path.write_text(json.dumps(config), encoding="utf-8")
        store = PreferenceStore(root)
        group_id = store.read_groups_v2()[0].id
        import hashlib
        selection = {"provider_source": "fake", "provider_id": "fake", "model_id": "fixture", "api_type": "fake", "endpoint_fingerprint": "sha256:" + hashlib.sha256(b"").hexdigest(), "thinking_level": "off", "max_tokens": 128, "timeout_seconds": 10, "config_version": 2}
        jobs = FeedbackJobs(root)
        preview = jobs.preview({"feedback": "需要简洁", "snapshot": self.snapshot(), "model_selection": selection})[0]
        jobs.authorize({"revision": 1, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
        return jobs, group_id, selection

    @staticmethod
    def snapshot(storage_mode: str = "ask") -> dict[str, str]:
        return {"session_id": "session-test", "task_key": "task-test", "user_entry_id": "user-test", "assistant_entry_id": "assistant-test", "user_text": "请用简洁中文回答", "assistant_text": "这是一个很长的回答。", "origin_verified": True, "storage_mode": storage_mode}

    @staticmethod
    def output(group_id: str) -> str:
        return json.dumps({"group_id": group_id, "target": {"type": "assistant_text", "description": "回答表达"}, "quote": {"source_alias": "assistant_result", "text": "很长的回答"}, "observations": ["回答冗长"], "actual_behavior": "回答包含过多铺陈", "expected_behavior": "用简洁中文回答", "task_summary": "回答一个中文请求", "evidence_summary": "用户希望结果简洁", "applicability": "一般中文答复", "nature": "preference", "specificity": "specific", "confidence": 0.9, "needs_review": False}, ensure_ascii=False)

    def claim(self, jobs: FeedbackJobs, job: dict[str, object], selection: dict[str, object]) -> dict[str, object]:
        if job["state"] == "blocked_consent":
            detail = jobs.get({"job_id": job["job_id"]})[0]
            snapshot = {**detail["snapshot"], "storage_mode": "ask"}
            try:
                revision = jobs._consent()["revision"] + 1
            except Exception:
                revision = 1
            preview = jobs.preview({"feedback": job["feedback"], "snapshot": snapshot, "model_selection": selection})[0]
            jobs.authorize({"revision": revision, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
            job = jobs.bind({"job_id": job["job_id"], "generation": job["generation"], "model_selection": selection, "consent_revision": revision})[0]["job"]
        result, _ = jobs.claim({"job_id": job["job_id"], "owner_id": "worker-one", "consent_revision": job["consent_revision"], "model_selection": selection, "lease_seconds": 30})
        return result["job"]

    def create(self, jobs: FeedbackJobs, group_id: str, selection: dict[str, object], request_id: str = "request") -> dict[str, object]:
        consent = jobs._consent()
        unconsumed = next((item for item in consent["authorizations"] if item["consumed_by"] is None), None)
        if unconsumed is None:
            revision = consent["revision"] + 1
            preview = jobs.preview({"feedback": "需要简洁", "snapshot": self.snapshot(), "model_selection": selection})[0]
            jobs.authorize({"revision": revision, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
        else:
            revision = unconsumed["revision"]
        result, _ = jobs.create(request_id, {"feedback": "需要简洁", "group_id": group_id, "snapshot": self.snapshot(), "model_selection": selection, "consent_revision": revision})
        return result["job"]

    def test_init_uses_latest_contract_and_stable_group_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            PreferenceStore.init(root)
            config = json.loads((root / "config.json").read_text())
            groups = json.loads((root / "repo/groups.json").read_text())
            self.assertEqual(config["schema_version"], 2)
            self.assertNotIn("auto_evolve", config)
            self.assertEqual(groups["schema_version"], 2)
            self.assertIn("id", groups["groups"][0])
            with self.assertRaises(Exception):
                PreferenceConfig.from_dict({**config, "schema_version": 1}, root)

    def test_request_id_is_idempotent_and_conflicting_payload_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs, group_id, selection = self.setUpRoot(Path(temporary))
            first, _ = jobs.create("same", {"feedback": "需要简洁", "group_id": group_id, "snapshot": self.snapshot(), "model_selection": selection, "consent_revision": 1})
            second, _ = jobs.create("same", {"feedback": "需要简洁", "group_id": group_id, "snapshot": self.snapshot(), "model_selection": selection, "consent_revision": 1})
            self.assertTrue(second["idempotent"])
            self.assertEqual(first["job"]["job_id"], second["job"]["job_id"])
            with self.assertRaises(PreferenceContractError):
                jobs.create("same", {"feedback": "换一条", "group_id": group_id, "snapshot": self.snapshot(), "model_selection": selection, "consent_revision": 1})

    def test_claim_renew_complete_uses_worker_lease_and_publishes_only_on_complete(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            job = self.create(jobs, group_id, selection)
            running = self.claim(jobs, job, selection)
            token = running["lease"]["token"]
            self.assertTrue((root / "local" / "worker.json").exists())
            renewed, _ = jobs.renew({"job_id": job["job_id"], "token": token, "lease_seconds": 30})
            finished, _ = jobs.complete({"job_id": job["job_id"], "token": token, "input_digest": renewed["job"]["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
            self.assertEqual(finished["job"]["state"], "needs_review")
            revision = finished["evidence_revision"]
            self.assertTrue((root / "local" / "evidence" / revision["evidence_id"] / f"{revision['revision_id']}.json").exists())
            self.assertFalse((root / "local" / "evidence-revisions.jsonl").exists())
            self.assertFalse((root / "local" / "worker.json").exists())

    def test_edit_cancel_delete_and_late_result_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs, group_id, selection = self.setUpRoot(Path(temporary))
            job = self.create(jobs, group_id, selection)
            running = self.claim(jobs, job, selection)
            with self.assertRaises(PreferenceContractError):
                jobs.edit({"job_id": job["job_id"], "generation": job["generation"], "feedback": "修改", "snapshot": self.snapshot()})
            edited, _ = jobs.edit({"job_id": job["job_id"], "generation": running["generation"], "feedback": "修改", "snapshot": self.snapshot()})
            self.assertFalse((Path(temporary) / "local" / "worker.json").exists())
            with self.assertRaises(PreferenceContractError):
                jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
            cancelled, _ = jobs.cancel({"job_id": job["job_id"], "generation": edited["job"]["generation"]})
            self.assertEqual(cancelled["job"]["state"], "cancelled")
            with self.assertRaises(PreferenceContractError):
                jobs.delete({"job_id": job["job_id"], "generation": edited["job"]["generation"]})

    def test_local_only_and_revoked_consent_never_claim(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            local = self.snapshot("local_only")
            created, _ = jobs.create("local", {"feedback": "仅保存", "group_id": group_id, "snapshot": local, "model_selection": selection, "consent_revision": 0})
            self.assertEqual(created["job"]["state"], "blocked_consent")
            with self.assertRaises(PreferenceContractError):
                jobs.claim({"job_id": created["job"]["job_id"], "owner_id": "worker-one", "consent_revision": 0, "model_selection": selection, "lease_seconds": 30})
            job = self.create(jobs, group_id, selection, "revoked")
            entry = jobs._consent()["authorizations"][0]
            jobs.authorize({"revision": 2, "allowed": False, "scope": "single", "input_signature": entry["input_signature"], "model_selection": selection})
            blocked = self.claim(jobs, job, selection)
            self.assertEqual(blocked["state"], "blocked_consent")
            self.assertEqual(blocked["error_code"], "consent_revoked")

    def test_unbound_local_feedback_requires_explicit_authorized_binding(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            created, _ = jobs.create("unbound-local", {"feedback": "good", "group_id": group_id, "snapshot": self.snapshot("local_only"), "model_selection": None, "consent_revision": 0})
            self.assertEqual(created["job"]["state"], "blocked_consent")
            self.assertIsNone(created["job"]["model_selection"])
            with self.assertRaises(PreferenceContractError):
                jobs.retry({"job_id": created["job"]["job_id"], "generation": created["job"]["generation"]})
            snapshot = {**self.snapshot("local_only"), "storage_mode": "ask"}
            preview = jobs.preview({"feedback": "good", "snapshot": snapshot, "model_selection": selection})[0]
            jobs.authorize({"revision": 2, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
            bound, _ = jobs.bind({"job_id": created["job"]["job_id"], "generation": created["job"]["generation"], "model_selection": selection, "consent_revision": 2})
            self.assertEqual(bound["job"]["state"], "queued")
            self.assertEqual(bound["job"]["model_selection"], selection)
            self.assertEqual(jobs.get({"job_id": created["job"]["job_id"]})[0]["snapshot"]["storage_mode"], "ask")
            self.assertEqual(self.claim(jobs, bound["job"], selection)["state"], "running")

    def test_send_authorization_revocation_blocks_before_dispatch_and_releases_worker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            job = self.create(jobs, group_id, selection, "authorize-send-revoked")
            running = self.claim(jobs, job, selection)
            entry = jobs._consent()["authorizations"][0]
            jobs.authorize({"revision": 2, "allowed": False, "scope": "single", "input_signature": entry["input_signature"], "model_selection": selection})
            blocked, _ = jobs.authorize_send({"job_id": job["job_id"], "token": running["lease"]["token"], "model_selection": selection, "consent_revision": 1, "endpoint_fingerprint": selection["endpoint_fingerprint"]})
            self.assertTrue(blocked["blocked"])
            self.assertEqual(blocked["job"]["state"], "blocked_consent")
            self.assertFalse((root / "local/worker.json").exists())

    def test_permanent_dispatch_rejection_is_durable_and_exact_input_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs, group_id, selection = self.setUpRoot(Path(temporary))
            job = self.create(jobs, group_id, selection, "permanent-dispatch")
            rejected, _ = jobs.reject_dispatch({"job_id": job["job_id"], "generation": job["generation"], "input_digest": job["input_digest"], "model_selection": selection, "consent_revision": 1, "claim_error_code": "invalid_contract"})
            self.assertEqual(rejected["job"]["state"], "failed")
            self.assertEqual(rejected["job"]["error_code"], "dispatch_invalid_contract")
            with self.assertRaises(PreferenceContractError):
                jobs.reject_dispatch({"job_id": job["job_id"], "generation": rejected["job"]["generation"], "input_digest": job["input_digest"], "model_selection": selection, "consent_revision": 1, "claim_error_code": "worker_busy"})

    def test_dispatch_rejection_cannot_overwrite_an_edit_or_cancel(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs, group_id, selection = self.setUpRoot(Path(temporary))
            edited_source = self.create(jobs, group_id, selection, "dispatch-edited")
            jobs.edit({"job_id": edited_source["job_id"], "generation": edited_source["generation"], "feedback": "fix: 修改后"})
            with self.assertRaises(PreferenceConflictError):
                jobs.reject_dispatch({"job_id": edited_source["job_id"], "generation": edited_source["generation"], "input_digest": edited_source["input_digest"], "model_selection": selection, "consent_revision": 1, "claim_error_code": "invalid_contract"})
            cancelled_source = self.create(jobs, group_id, selection, "dispatch-cancelled")
            jobs.cancel({"job_id": cancelled_source["job_id"], "generation": cancelled_source["generation"]})
            with self.assertRaises(PreferenceConflictError):
                jobs.reject_dispatch({"job_id": cancelled_source["job_id"], "generation": cancelled_source["generation"], "input_digest": cancelled_source["input_digest"], "model_selection": selection, "consent_revision": 1, "claim_error_code": "invalid_contract"})
            states = {item["job_id"]: item["state"] for item in jobs.list()[0]["jobs"]}
            self.assertEqual(states[edited_source["job_id"]], "blocked_consent")
            self.assertEqual(states[cancelled_source["job_id"]], "cancelled")

    def test_two_exact_authorizations_queue_independently_and_edit_requires_a_new_signature(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            first = self.create(jobs, group_id, selection, "first-exact")
            second_snapshot = {
                **self.snapshot(),
                "session_id": "session-second",
                "task_key": "task-second",
                "user_entry_id": "user-second",
                "assistant_entry_id": "assistant-second",
                "user_text": "第二个已批准请求",
            }
            preview = jobs.preview({"feedback": "fix: 第二份反馈", "snapshot": second_snapshot, "model_selection": selection})[0]
            jobs.authorize({"revision": 2, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
            second = jobs.create("second-exact", {
                "feedback": "fix: 第二份反馈", "group_id": group_id, "snapshot": second_snapshot,
                "model_selection": selection, "consent_revision": 2,
            })[0]["job"]
            self.assertEqual([item["state"] for item in jobs.list()[0]["jobs"]], ["queued", "queued"])
            running_first = self.claim(jobs, first, selection)
            jobs.cancel_lease({"job_id": first["job_id"], "token": running_first["lease"]["token"]})
            running_second = self.claim(jobs, second, selection)
            self.assertEqual(running_second["state"], "running")
            jobs.cancel_lease({"job_id": second["job_id"], "token": running_second["lease"]["token"]})

            fresh = self.create(jobs, group_id, selection, "edit-signature")
            edited = jobs.edit({"job_id": fresh["job_id"], "generation": fresh["generation"], "feedback": "fix: 修改后的反馈"})[0]["job"]
            self.assertEqual((edited["state"], edited["error_code"]), ("blocked_consent", "input_changed_requires_authorization"))
            with self.assertRaises(PreferenceContractError):
                jobs.claim({"job_id": edited["job_id"], "owner_id": "old-signature", "consent_revision": edited["consent_revision"], "model_selection": selection, "lease_seconds": 30})

    def test_usage_records_frozen_model_limit_and_unknown_cost(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs, group_id, selection = self.setUpRoot(Path(temporary))
            job = self.create(jobs, group_id, selection, "usage")
            running = self.claim(jobs, job, selection)
            usage = {
                "known": True, "input_tokens": 12, "output_tokens": 8, "total_tokens": 20,
                "cost_usd": None, "cost_status": "unknown", "provider_id": selection["provider_id"],
                "model_id": selection["model_id"], "max_tokens": selection["max_tokens"],
            }
            completed = jobs.complete({
                "job_id": job["job_id"], "token": running["lease"]["token"],
                "input_digest": running["input_digest"], "model_selection": selection,
                "consent_revision": running["consent_revision"], "output": self.output(group_id), "usage": usage,
            })[0]["job"]
            self.assertEqual(completed["usage"], usage)
            invalid = {**usage, "max_tokens": 999}
            self.assertNotEqual(invalid["max_tokens"], completed["model_selection"]["max_tokens"])

    def test_one_root_worker_lease_blocks_a_second_job(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs, group_id, selection = self.setUpRoot(Path(temporary))
            first = self.create(jobs, group_id, selection, "worker-first")
            second = self.create(jobs, group_id, selection, "worker-second")
            self.claim(jobs, first, selection)
            with self.assertRaises(PreferenceContractError):
                self.claim(jobs, second, selection)

    def test_daily_budget_is_persistently_visible_and_blocks_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            config_path = root / "config.json"; config = json.loads(config_path.read_text()); config["learning"]["max_requests_per_day"] = 1; config_path.write_text(json.dumps(config))
            first = self.create(jobs, group_id, selection, "budget-first")
            second = self.create(jobs, group_id, selection, "budget-second")
            running = self.claim(jobs, first, selection)
            jobs.fail({"job_id": first["job_id"], "token": running["lease"]["token"], "code": "test_failure"})
            blocked, _ = jobs.claim({"job_id": second["job_id"], "owner_id": "worker-two", "consent_revision": second["consent_revision"], "model_selection": selection, "lease_seconds": 30})
            self.assertTrue(blocked["blocked"])
            listed, _ = jobs.get({"job_id": second["job_id"]})
            self.assertEqual(listed["job"]["state"], "blocked_budget")

    def test_forged_quote_and_wrong_group_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            jobs, group_id, selection = self.setUpRoot(Path(temporary))
            job = self.create(jobs, group_id, selection)
            running = self.claim(jobs, job, selection)
            forged = self.output(group_id).replace("很长的回答", "伪造摘录")
            with self.assertRaises(PreferenceContractError):
                jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": forged})

    def test_complete_rechecks_current_consent_and_config_before_publishing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            job = self.create(jobs, group_id, selection, "late-consent")
            running = self.claim(jobs, job, selection)
            entry = jobs._consent()["authorizations"][0]
            jobs.authorize({"revision": 2, "allowed": False, "scope": "single", "input_signature": entry["input_signature"], "model_selection": selection})
            blocked, _ = jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
            self.assertEqual(blocked["job"]["state"], "blocked_consent")
            self.assertEqual(blocked["job"]["error_code"], "consent_revoked")
            self.assertFalse((root / "local/evidence-revisions.jsonl").exists())

    def test_expired_snapshot_becomes_visible_needs_review(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            config_path = root / "config.json"; config = json.loads(config_path.read_text()); config["privacy"]["snapshot_retention_days"] = 1; config_path.write_text(json.dumps(config))
            job = self.create(jobs, group_id, selection, "ttl")
            jobs_path = root / "local" / "feedback-jobs.json"; rows = json.loads(jobs_path.read_text()); rows[0]["created_at"] = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat(); jobs_path.write_text(json.dumps(rows))
            result, _ = jobs.sweep()
            self.assertEqual(result["jobs"][0]["state"], "needs_review")
            self.assertIsNone(result["jobs"][0]["snapshot_ref"])

    def test_completed_feedback_edit_reuses_stable_evidence_identity_and_parents_published_withdrawal(self) -> None:
        for published in (False, True):
            with self.subTest(published=published), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
                job = self.create(jobs, group_id, selection, f"edit-completed-{published}")
                running = self.claim(jobs, job, selection)
                completed, _ = jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
                first_revision = completed["evidence_revision"]
                evidence = EvidenceStore(root)
                if published:
                    row = evidence.view()["evidence"][0]
                    preview, _ = evidence.preview_publish({"evidence_id": row["evidence_id"], "expected_heads": row["heads"]}, None)
                    evidence.publish("publish-before-edit", {"evidence_id": row["evidence_id"], "expected_heads": row["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
                edited, _ = jobs.edit({"job_id": job["job_id"], "generation": completed["job"]["generation"], "feedback": "需要更加简洁"})
                if published:
                    withdrawn = evidence.view()["evidence"][0]
                    self.assertEqual(withdrawn["status"], "withdrawn")
                    withdrawal_head = withdrawn["heads"]
                else:
                    self.assertEqual(evidence.view()["evidence"], [])
                    withdrawal_head = []
                rerun = self.claim(jobs, edited["job"], selection)
                recompleted, _ = jobs.complete({"job_id": job["job_id"], "token": rerun["lease"]["token"], "input_digest": rerun["input_digest"], "model_selection": selection, "consent_revision": rerun["consent_revision"], "output": self.output(group_id)})
                if published:
                    self.assertTrue(recompleted["evidence_withdrawn"])
                    self.assertEqual(recompleted["job"]["state"], "needs_review")
                    self.assertEqual(recompleted["job"]["error_code"], "evidence_withdrawn")
                    self.assertEqual(evidence.view()["evidence"][0]["heads"], withdrawal_head)
                    restored, _ = evidence.restore("explicit-feedback-restore", {
                        "evidence_id": first_revision["evidence_id"],
                        "expected_heads": withdrawal_head,
                        "content_revision_id": first_revision["revision_id"],
                    }, None)
                    self.assertEqual(restored["evidence_revision"]["author_kind"], "user")
                    queued = jobs.get({"job_id": job["job_id"]})[0]["job"]
                    self.assertEqual(queued["state"], "queued")
                    rerun_after_restore = self.claim(jobs, queued, selection)
                    after_restore, _ = jobs.complete({"job_id": job["job_id"], "token": rerun_after_restore["lease"]["token"], "input_digest": rerun_after_restore["input_digest"], "model_selection": selection, "consent_revision": rerun_after_restore["consent_revision"], "output": self.output(group_id)})
                    self.assertEqual(after_restore["evidence_revision"]["evidence_id"], first_revision["evidence_id"])
                    self.assertEqual(after_restore["evidence_revision"]["operation"], "upsert")
                    self.assertEqual(after_restore["evidence_revision"]["parents"], [restored["evidence_revision"]["revision_id"]])
                else:
                    self.assertEqual(recompleted["evidence_revision"]["evidence_id"], first_revision["evidence_id"])
                    self.assertEqual(recompleted["evidence_revision"]["parents"], [])

    def test_withdraw_during_reextraction_cannot_be_revived_by_late_extractor_completion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            job = self.create(jobs, group_id, selection, "withdraw-during-reextract")
            running = self.claim(jobs, job, selection)
            completed, _ = jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
            evidence = EvidenceStore(root)
            row = evidence.view()["evidence"][0]
            preview, _ = evidence.preview_publish({"evidence_id": row["evidence_id"], "expected_heads": row["heads"]}, None)
            evidence.publish("publish-before-reextract", {"evidence_id": row["evidence_id"], "expected_heads": row["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
            edited, _ = jobs.edit({"job_id": job["job_id"], "generation": completed["job"]["generation"], "feedback": "重新整理"})
            host_withdraw = evidence.view()["evidence"][0]
            restored, _ = evidence.restore("user-restore-before-claim", {
                "evidence_id": row["evidence_id"], "expected_heads": host_withdraw["heads"],
                "content_revision_id": completed["evidence_revision"]["revision_id"],
            }, None)
            queued = jobs.get({"job_id": job["job_id"]})[0]["job"]
            claimed = self.claim(jobs, queued, selection)
            active = evidence.view()["evidence"][0]
            withdrawn, _ = evidence.withdraw("user-withdraw-during-model", {
                "evidence_id": row["evidence_id"], "expected_heads": active["heads"],
            }, None)
            late, _ = jobs.complete({"job_id": job["job_id"], "token": claimed["lease"]["token"], "input_digest": claimed["input_digest"], "model_selection": selection, "consent_revision": claimed["consent_revision"], "output": self.output(group_id)})
            self.assertTrue(late["evidence_withdrawn"])
            self.assertEqual(late["job"]["error_code"], "evidence_withdrawn")
            final = evidence.view()["evidence"][0]
            self.assertEqual(final["status"], "withdrawn")
            self.assertEqual(final["heads"], [withdrawn["evidence_revision"]["revision_id"]])
            self.assertNotEqual(final["heads"], [restored["evidence_revision"]["revision_id"]])

    def test_recomplete_does_not_auto_resolve_a_new_concurrent_head(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            job = self.create(jobs, group_id, selection, "concurrent-recomplete")
            running = self.claim(jobs, job, selection)
            completed, _ = jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
            evidence = EvidenceStore(root)
            row = evidence.view()["evidence"][0]
            preview, _ = evidence.preview_publish({"evidence_id": row["evidence_id"], "expected_heads": row["heads"]}, None)
            evidence.publish("publish-for-conflict", {"evidence_id": row["evidence_id"], "expected_heads": row["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
            edited, _ = jobs.edit({"job_id": job["job_id"], "generation": completed["job"]["generation"], "feedback": "重新整理"})
            withdrawal = evidence.view()["evidence"][0]
            original = completed["evidence_revision"]
            concurrent = json.loads(json.dumps(original))
            concurrent["revision_id"] = "revision-concurrent-recomplete"
            concurrent["parents"] = [original["revision_id"]]
            concurrent["content"]["expected_behavior"] = "并发设备的新正文"
            path = root / "repo/evidence" / concurrent["evidence_id"] / f"{concurrent['revision_id']}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(stable_json_dumps(concurrent) + "\n", encoding="utf-8")
            rerun = self.claim(jobs, edited["job"], selection)
            result, _ = jobs.complete({"job_id": job["job_id"], "token": rerun["lease"]["token"], "input_digest": rerun["input_digest"], "model_selection": selection, "consent_revision": rerun["consent_revision"], "output": self.output(group_id)})
            self.assertTrue(result["evidence_conflict"])
            self.assertEqual(result["job"]["state"], "needs_review")
            self.assertEqual(result["job"]["error_code"], "evidence_conflict")
            current = evidence.view()["evidence"][0]
            self.assertEqual(current["status"], "withdrawn")
            self.assertEqual(set(current["heads"]), {withdrawal["heads"][0], concurrent["revision_id"]})

    def test_corrupt_existing_revision_cannot_be_treated_as_missing_by_model_completion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            job = self.create(jobs, group_id, selection, "corrupt-existing")
            running = self.claim(jobs, job, selection)
            completed, _ = jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
            evidence = EvidenceStore(root)
            row = evidence.view()["evidence"][0]
            preview, _ = evidence.preview_publish({"evidence_id": row["evidence_id"], "expected_heads": row["heads"]}, None)
            evidence.publish("publish-before-corruption", {"evidence_id": row["evidence_id"], "expected_heads": row["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
            edited, _ = jobs.edit({"job_id": job["job_id"], "generation": completed["job"]["generation"], "feedback": "重新整理"})
            files_before = sorted((root / "local/evidence" / row["evidence_id"]).glob("*.json"))
            files_before[0].write_text("{broken", encoding="utf-8")
            claimed = self.claim(jobs, edited["job"], selection)
            result, _ = jobs.complete({"job_id": job["job_id"], "token": claimed["lease"]["token"], "input_digest": claimed["input_digest"], "model_selection": selection, "consent_revision": claimed["consent_revision"], "output": self.output(group_id)})
            self.assertTrue(result["evidence_invalid"])
            self.assertEqual(result["job"]["state"], "needs_review")
            self.assertEqual(result["job"]["error_code"], "evidence_invalid")
            self.assertEqual(sorted((root / "local/evidence" / row["evidence_id"]).glob("*.json")), files_before)

    def test_feedback_delete_removes_unpublished_evidence_or_withdraws_published_evidence(self) -> None:
        for published in (False, True):
            with self.subTest(published=published), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
                job = self.create(jobs, group_id, selection, f"delete-completed-{published}")
                running = self.claim(jobs, job, selection)
                completed, _ = jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
                evidence = EvidenceStore(root)
                if published:
                    row = evidence.view()["evidence"][0]
                    preview, _ = evidence.preview_publish({"evidence_id": row["evidence_id"], "expected_heads": row["heads"]}, None)
                    evidence.publish("publish-before-delete", {"evidence_id": row["evidence_id"], "expected_heads": row["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
                jobs.delete({"job_id": job["job_id"], "generation": completed["job"]["generation"]})
                self.assertEqual(jobs.list()[0]["jobs"], [])
                if published:
                    self.assertEqual(evidence.view()["evidence"][0]["status"], "withdrawn")
                else:
                    self.assertEqual(evidence.view()["evidence"], [])

    def test_feedback_evidence_linkage_rolls_back_atomically_on_transaction_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, selection = self.setUpRoot(root)
            job = self.create(jobs, group_id, selection, "atomic-edit")
            running = self.claim(jobs, job, selection)
            completed, _ = jobs.complete({"job_id": job["job_id"], "token": running["lease"]["token"], "input_digest": running["input_digest"], "model_selection": selection, "consent_revision": 1, "output": self.output(group_id)})
            before_jobs = (root / "local/feedback-jobs.json").read_bytes()
            before_evidence = EvidenceStore(root).view()
            with patch("wikiskill_preference_core.transactions.PersistentTransaction.commit_local", side_effect=RuntimeError("injected")):
                with self.assertRaises(RuntimeError):
                    jobs.edit({"job_id": job["job_id"], "generation": completed["job"]["generation"], "feedback": "修改失败"})
            self.assertEqual((root / "local/feedback-jobs.json").read_bytes(), before_jobs)
            self.assertEqual(EvidenceStore(root).view(), before_evidence)

    def test_user_edit_is_a_local_weak_record_without_snapshot_or_model_and_can_be_narrowed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); jobs, group_id, _selection = self.setUpRoot(root)
            created, _ = jobs.create_user_edit("user-edit", {
                "task_key": "task-user-edit",
                "task_summary": "修改生成的文档",
                "paths": ["docs/a.md", "docs/b.md"],
                "diffs": {"docs/a.md": "@@ -1 +1 @@\n-old\n+new"},
                "reason": None,
                "group_id": None,
            })
            job = created["job"]
            self.assertEqual(job["source_kind"], "user_edit")
            self.assertEqual(job["state"], "needs_review")
            self.assertIsNone(job["snapshot_ref"])
            self.assertIsNone(job["model_selection"])
            self.assertFalse((root / "local/feedback-snapshots" / f"{job['job_id']}.json").exists())
            updated, _ = jobs.update_user_edit({
                "job_id": job["job_id"], "generation": job["generation"],
                "reason": "标题层级应保持简洁", "group_id": group_id, "paths": ["docs/a.md"],
            })
            self.assertEqual(updated["job"]["source_context"]["paths"], ["docs/a.md"])
            self.assertEqual(updated["job"]["group_id"], group_id)
            self.assertEqual(updated["job"]["error_code"], "user_edit_weak_evidence")


if __name__ == "__main__":
    unittest.main()
