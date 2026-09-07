from __future__ import annotations

import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from _support import git, request, run_cli, run_cli_process
import test_feedback_jobs
from wikiskill_preference_core.contracts import stable_json_dumps
from wikiskill_preference_core.evidence import EvidenceStore
from wikiskill_preference_core.errors import PreferenceConflictError, PreferenceIntegrityError
from wikiskill_preference_core.store import PreferenceStore


class EvidenceTest(unittest.TestCase):
    def complete_evidence(self, root: Path, request_id: str = "feedback") -> tuple[EvidenceStore, dict[str, object], object, object, object]:
        helper = test_feedback_jobs.FeedbackJobsTest()
        jobs, group_id, selection = helper.setUpRoot(root)
        job = helper.create(jobs, group_id, selection, request_id)
        running = helper.claim(jobs, job, selection)
        completed, _ = jobs.complete({
            "job_id": job["job_id"],
            "token": running["lease"]["token"],
            "input_digest": running["input_digest"],
            "model_selection": selection,
            "consent_revision": 1,
            "output": helper.output(group_id),
        })
        return EvidenceStore(root), completed, helper, jobs, selection

    def revision(
        self,
        group_id: str,
        revision_id: str,
        parents: list[str],
        *,
        evidence_id: str = "evidence-test",
        operation: str = "upsert",
        author_kind: str | None = None,
    ) -> dict[str, object]:
        content = {
            "raw_feedback": "fix: 请简洁",
            "feedback_created_at": "2026-01-01T00:00:00+00:00",
            "task_summary": "任务摘要",
            "evidence_summary": "证据摘要",
            "feedback_target": {"type": "assistant_text", "description": "回答", "quote": None},
            "observations": ["回答过长"],
            "actual_behavior": "回答过长",
            "expected_behavior": "回答简洁",
            "applicability": "一般回答",
            "nature": "preference",
            "specificity": "specific",
            "confidence": 0.9,
            "needs_review": False,
            "context_completeness": "complete",
            "sanitizer_version": "preference-sanitizer-v1",
            "extractor_prompt_version": "personal-preference-feedback-extractor-v2",
        }
        return {
            "schema_version": 1,
            "evidence_id": evidence_id,
            "revision_id": revision_id,
            "parents": parents,
            "operation": operation,
            "recorded_at": "2026-01-01T00:00:00+00:00",
            "author_kind": author_kind or ("extractor" if operation == "upsert" else "user" if operation == "restore" else "host"),
            "origin_task_key": "task-test",
            "origin_verified": True,
            "feedback_id": "feedback-test",
            "group_id": group_id,
            "content": None if operation == "withdraw" else content,
        }

    @staticmethod
    def write_revision(root: Path, revision: dict[str, object], *, location: str = "local") -> None:
        path = root / location / "evidence" / str(revision["evidence_id"]) / f"{revision['revision_id']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(stable_json_dumps(revision) + "\n", encoding="utf-8")

    def test_local_repo_copy_is_deduplicated_and_different_content_same_id_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = PreferenceStore.init(root)
            group_id = store.read_groups_v2()[0].id
            revision = self.revision(group_id, "revision-one", [])
            self.write_revision(root, revision)
            self.write_revision(root, revision, location="repo")
            row = EvidenceStore(root).view()["evidence"][0]
            self.assertEqual(row["revision_count"], 1)
            self.assertEqual(row["local_revision_count"], 1)
            self.assertEqual(row["repo_revision_count"], 1)
            changed = copy.deepcopy(revision)
            changed["content"]["expected_behavior"] = "不同正文"
            self.write_revision(root, changed, location="repo")
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()

    def test_missing_parent_cycle_self_parent_and_duplicate_parent_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            group_id = PreferenceStore.init(root).read_groups_v2()[0].id
            self.write_revision(root, self.revision(group_id, "revision-child", ["revision-missing"]))
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            group_id = PreferenceStore.init(root).read_groups_v2()[0].id
            self.write_revision(root, self.revision(group_id, "revision-a", ["revision-b"]))
            self.write_revision(root, self.revision(group_id, "revision-b", ["revision-a"]))
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()
        for parents in (["revision-a"], ["revision-root", "revision-root"]):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                group_id = PreferenceStore.init(root).read_groups_v2()[0].id
                if parents[0] == "revision-root":
                    self.write_revision(root, self.revision(group_id, "revision-root", []))
                self.write_revision(root, self.revision(group_id, "revision-a", list(parents)))
                with self.assertRaises(PreferenceIntegrityError):
                    EvidenceStore(root).view()

    def test_unknown_jsonl_and_external_extractor_restore_or_withdraw_parent_upsert_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            PreferenceStore.init(root)
            (root / "repo/evidence/legacy.jsonl").write_text("{}\n", encoding="utf-8")
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            group_id = PreferenceStore.init(root).read_groups_v2()[0].id
            initial = self.revision(group_id, "revision-root", [])
            withdraw = self.revision(group_id, "revision-withdraw", ["revision-root"], operation="withdraw")
            extractor_restore = self.revision(
                group_id,
                "revision-extractor-restore",
                ["revision-withdraw"],
                operation="restore",
                author_kind="extractor",
            )
            for revision in (initial, withdraw, extractor_restore):
                self.write_revision(root, revision)
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            group_id = PreferenceStore.init(root).read_groups_v2()[0].id
            initial = self.revision(group_id, "revision-root", [])
            withdraw = self.revision(group_id, "revision-withdraw", ["revision-root"], operation="withdraw")
            invalid_upsert = self.revision(
                group_id,
                "revision-invalid-upsert",
                ["revision-withdraw"],
                author_kind="extractor",
            )
            for revision in (initial, withdraw, invalid_upsert):
                self.write_revision(root, revision)
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()

    def test_concurrent_upserts_conflict_withdraw_wins_and_restore_requires_all_heads(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence, _completed, _helper, _jobs, _selection = self.complete_evidence(root)
            initial = evidence.view()["evidence"][0]
            base = initial["heads"]
            first, _ = evidence.revise("revise-one", {
                "evidence_id": initial["evidence_id"], "expected_heads": base,
                "patch": {"expected_behavior": "设备 A 的修订"},
            }, None)
            # Simulate a second device that only saw the original head.
            second_revision = copy.deepcopy(first["evidence_revision"])
            second_revision["revision_id"] = "revision-concurrent"
            second_revision["parents"] = base
            second_revision["content"]["expected_behavior"] = "设备 B 的修订"
            self.write_revision(root, second_revision)
            conflict = evidence.view()["evidence"][0]
            self.assertEqual(conflict["status"], "conflict")
            withdrawn, _ = evidence.withdraw("withdraw-all", {
                "evidence_id": initial["evidence_id"], "expected_heads": conflict["heads"],
            }, None)
            self.assertEqual(withdrawn["evidence_revision"]["operation"], "withdraw")
            self.assertEqual(evidence.view()["evidence"][0]["status"], "withdrawn")
            current = evidence.view()["evidence"][0]
            with self.assertRaises(PreferenceConflictError):
                evidence.restore("stale-restore", {
                    "evidence_id": initial["evidence_id"], "expected_heads": base,
                    "content_revision_id": first["evidence_revision"]["revision_id"],
                }, None)
            restored, _ = evidence.restore("restore-all", {
                "evidence_id": initial["evidence_id"], "expected_heads": current["heads"],
                "content_revision_id": first["evidence_revision"]["revision_id"],
            }, None)
            self.assertEqual(restored["evidence_revision"]["parents"], current["heads"])
            self.assertEqual(evidence.view()["evidence"][0]["status"], "active")

    def test_publish_requires_exact_preview_closure_and_never_exports_local_private_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence, _completed, _helper, _jobs, _selection = self.complete_evidence(root)
            initial = evidence.view()["evidence"][0]
            revised, _ = evidence.revise("revise", {
                "evidence_id": initial["evidence_id"], "expected_heads": initial["heads"],
                "patch": {"expected_behavior": "修订后的期望"},
            }, None)
            current = evidence.view()["evidence"][0]
            preview, _ = evidence.preview_publish({
                "evidence_id": initial["evidence_id"], "expected_heads": current["heads"],
            }, None)
            self.assertEqual(len(preview["revision_ids"]), 2)
            self.assertEqual([entry["revision"] for entry in preview["entries"]], [
                evidence._evidence_revisions(initial["evidence_id"])[revision_id]
                for revision_id in preview["revision_ids"]
            ])
            self.assertEqual(preview["entries"][0]["revision"]["content"]["raw_feedback"], "需要简洁")
            self.assertEqual(list((root / "repo/evidence").rglob("*.json")), [])
            changed, _ = evidence.revise("changed-after-preview", {
                "evidence_id": initial["evidence_id"], "expected_heads": current["heads"],
                "patch": {"applicability": "预览后的新范围"},
            }, None)
            with self.assertRaises(PreferenceConflictError):
                evidence.publish("stale-preview", {
                    "evidence_id": initial["evidence_id"], "expected_heads": current["heads"],
                    "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"],
                }, None)
            self.assertEqual(list((root / "repo/evidence").rglob("*.json")), [])
            current = evidence.view()["evidence"][0]
            preview, _ = evidence.preview_publish({"evidence_id": initial["evidence_id"], "expected_heads": current["heads"]}, None)
            with self.assertRaises(PreferenceConflictError):
                evidence.publish("partial", {
                    "evidence_id": initial["evidence_id"], "expected_heads": current["heads"],
                    "preview_digest": preview["preview_digest"],
                    "revision_ids": [changed["evidence_revision"]["revision_id"]],
                }, None)
            published, _ = evidence.publish("publish", {
                "evidence_id": initial["evidence_id"], "expected_heads": current["heads"],
                "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"],
            }, None)
            retried, _ = evidence.publish("publish", {
                "evidence_id": initial["evidence_id"], "expected_heads": current["heads"],
                "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"],
            }, None)
            self.assertEqual(published, retried)
            repo_files = [path.relative_to(root / "repo").as_posix() for path in (root / "repo").rglob("*") if path.is_file() and ".git" not in path.parts]
            self.assertFalse(any("feedback-snapshot" in path or "consent" in path or "worker" in path or "activations" in path for path in repo_files))
            self.assertEqual(git(root / "repo", "status", "--porcelain"), "")

    def test_delete_local_invalidates_feedback_reference_before_removing_revisions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence, completed, _helper, jobs, _selection = self.complete_evidence(root)
            row = evidence.view()["evidence"][0]
            deleted, _ = evidence.delete_local("delete-with-reference", {
                "evidence_id": row["evidence_id"], "expected_heads": row["heads"],
            }, None)
            self.assertEqual(deleted["invalidated_feedback_jobs"], [completed["job"]["job_id"]])
            job = jobs.list()[0]["jobs"][0]
            self.assertIsNone(job["result_ref"])
            self.assertEqual(job["state"], "needs_review")
            self.assertEqual(job["error_code"], "evidence_deleted")
            self.assertEqual(evidence.view()["evidence"], [])

    def test_symlink_and_sensitive_revision_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            group_id = PreferenceStore.init(root).read_groups_v2()[0].id
            revision = self.revision(group_id, "revision-secret", [])
            revision["content"]["raw_feedback"] = "token=sk-abcdefghijklmnop"
            self.write_revision(root, revision)
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            PreferenceStore.init(root)
            outside = root / "outside"
            outside.mkdir()
            evidence_dir = root / "local/evidence/evidence-link"
            evidence_dir.parent.mkdir(parents=True, exist_ok=True)
            evidence_dir.symlink_to(outside, target_is_directory=True)
            with self.assertRaises(PreferenceIntegrityError):
                EvidenceStore(root).view()

    def test_feedback_edit_delete_private_ancestors_require_full_preview_before_two_device_withdrawal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            device_a = base / "a"
            evidence, completed, helper, jobs, selection = self.complete_evidence(device_a, "private-ancestor")
            first = completed["evidence_revision"]
            initial = evidence.view()["evidence"][0]
            initial_preview, _ = evidence.preview_publish({"evidence_id": initial["evidence_id"], "expected_heads": initial["heads"]}, None)
            evidence.publish("publish-only-initial", {"evidence_id": initial["evidence_id"], "expected_heads": initial["heads"], "preview_digest": initial_preview["preview_digest"], "revision_ids": initial_preview["revision_ids"]}, None)

            edited, _ = jobs.edit({"job_id": completed["job"]["job_id"], "generation": completed["job"]["generation"], "feedback": "新的私有反馈正文"})
            blocked_claim = helper.claim(jobs, edited["job"], selection)
            blocked, _ = jobs.complete({"job_id": completed["job"]["job_id"], "token": blocked_claim["lease"]["token"], "input_digest": blocked_claim["input_digest"], "model_selection": selection, "consent_revision": blocked_claim["consent_revision"], "output": helper.output(initial["group_id"])})
            self.assertTrue(blocked["evidence_withdrawn"])
            first_withdraw = evidence.view()["evidence"][0]
            restored, _ = evidence.restore("restore-for-private-reextract", {
                "evidence_id": initial["evidence_id"], "expected_heads": first_withdraw["heads"],
                "content_revision_id": first["revision_id"],
            }, None)
            queued = jobs.get({"job_id": completed["job"]["job_id"]})[0]["job"]
            reextract_claim = helper.claim(jobs, queued, selection)
            reextracted, _ = jobs.complete({"job_id": completed["job"]["job_id"], "token": reextract_claim["lease"]["token"], "input_digest": reextract_claim["input_digest"], "model_selection": selection, "consent_revision": reextract_claim["consent_revision"], "output": helper.output(initial["group_id"])})
            jobs.delete({"job_id": completed["job"]["job_id"], "generation": reextracted["job"]["generation"]})
            pending = evidence.view()["evidence"][0]
            self.assertTrue(pending["withdrawal_pending_publish"])
            self.assertEqual(run_cli(device_a, ["status"])["pending_evidence_withdrawal_publish_count"], 1)
            run_cli(device_a, ["sync"])
            self.assertTrue(evidence.view()["evidence"][0]["withdrawal_pending_publish"])

            preview, _ = evidence.preview_publish({"evidence_id": initial["evidence_id"], "expected_heads": pending["heads"]}, None)
            self.assertEqual(len(preview["entries"]), 4)
            by_id = {entry["revision_id"]: entry for entry in preview["entries"]}
            self.assertEqual(by_id[restored["evidence_revision"]["revision_id"]]["revision"]["content"]["raw_feedback"], first["content"]["raw_feedback"])
            self.assertEqual(by_id[reextracted["evidence_revision"]["revision_id"]]["revision"]["content"]["raw_feedback"], "新的私有反馈正文")
            repo_ids_before = {path.stem for path in (device_a / "repo/evidence" / initial["evidence_id"]).glob("*.json")}
            self.assertEqual(repo_ids_before, {first["revision_id"]})
            # Preview cancellation is represented by not invoking publish; it must export nothing.
            self.assertEqual({path.stem for path in (device_a / "repo/evidence" / initial["evidence_id"]).glob("*.json")}, repo_ids_before)

            evidence.publish("approve-private-closure", {"evidence_id": initial["evidence_id"], "expected_heads": pending["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
            self.assertFalse(evidence.view()["evidence"][0]["withdrawal_pending_publish"])
            remote = base / "remote.git"
            subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            run_cli(device_a, ["sync"])
            device_b = base / "b"
            device_b.mkdir()
            subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            run_cli(device_b, ["init"])
            received = EvidenceStore(device_b).view()["evidence"][0]
            self.assertEqual(received["status"], "withdrawn")
            self.assertFalse(received["withdrawal_pending_publish"])

    def test_two_devices_concurrent_edit_withdraw_and_explicit_restore_converge_through_bare_remote(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            remote = base / "remote.git"
            subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)
            device_a = base / "a"
            evidence_a, _completed, _helper, _jobs, _selection = self.complete_evidence(device_a)
            initial = evidence_a.view()["evidence"][0]
            preview, _ = evidence_a.preview_publish({"evidence_id": initial["evidence_id"], "expected_heads": initial["heads"]}, None)
            evidence_a.publish("publish-initial", {"evidence_id": initial["evidence_id"], "expected_heads": initial["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            run_cli(device_a, ["sync"])

            device_b = base / "b"
            device_b.mkdir()
            subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            run_cli(device_b, ["init"])
            evidence_b = EvidenceStore(device_b)
            base_heads = evidence_b.view()["evidence"][0]["heads"]

            revised_a, _ = evidence_a.revise("device-a-edit", {
                "evidence_id": initial["evidence_id"], "expected_heads": base_heads,
                "patch": {"expected_behavior": "设备 A 的新期望"},
            }, None)
            row_a = evidence_a.view()["evidence"][0]
            preview_a, _ = evidence_a.preview_publish({"evidence_id": initial["evidence_id"], "expected_heads": row_a["heads"]}, None)
            evidence_a.publish("publish-device-a-edit", {"evidence_id": initial["evidence_id"], "expected_heads": row_a["heads"], "preview_digest": preview_a["preview_digest"], "revision_ids": preview_a["revision_ids"]}, None)
            run_cli(device_a, ["sync"])

            evidence_b.withdraw("device-b-withdraw", {"evidence_id": initial["evidence_id"], "expected_heads": base_heads}, None)
            row_b = evidence_b.view()["evidence"][0]
            preview_b, _ = evidence_b.preview_publish({"evidence_id": initial["evidence_id"], "expected_heads": row_b["heads"]}, None)
            evidence_b.publish("publish-device-b-withdraw", {"evidence_id": initial["evidence_id"], "expected_heads": row_b["heads"], "preview_digest": preview_b["preview_digest"], "revision_ids": preview_b["revision_ids"]}, None)
            run_cli(device_b, ["sync"])
            self.assertEqual(evidence_b.view()["evidence"][0]["status"], "withdrawn")

            run_cli(device_a, ["sync"])
            withdrawn_a = evidence_a.view()["evidence"][0]
            self.assertEqual(withdrawn_a["status"], "withdrawn")
            restored, _ = evidence_a.restore("device-a-restore", {
                "evidence_id": initial["evidence_id"],
                "expected_heads": withdrawn_a["heads"],
                "content_revision_id": revised_a["evidence_revision"]["revision_id"],
            }, None)
            self.assertEqual(set(restored["evidence_revision"]["parents"]), set(withdrawn_a["heads"]))
            restored_a = evidence_a.view()["evidence"][0]
            restore_preview, _ = evidence_a.preview_publish({"evidence_id": initial["evidence_id"], "expected_heads": restored_a["heads"]}, None)
            evidence_a.publish("publish-restore", {"evidence_id": initial["evidence_id"], "expected_heads": restored_a["heads"], "preview_digest": restore_preview["preview_digest"], "revision_ids": restore_preview["revision_ids"]}, None)
            run_cli(device_a, ["sync"])
            run_cli(device_b, ["sync"])
            converged_a = evidence_a.view()["evidence"][0]
            converged_b = evidence_b.view()["evidence"][0]
            self.assertEqual(converged_a["heads"], converged_b["heads"])
            self.assertEqual(converged_a["status"], converged_b["status"])
            self.assertEqual(converged_a["revision"], converged_b["revision"])
            self.assertEqual(converged_b["status"], "active")

    def test_group_delete_cleans_unpublished_jobs_and_same_name_rebuild_cannot_reclaim_published_history(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence, completed, _helper, jobs, _selection = self.complete_evidence(root)
            row = evidence.view()["evidence"][0]
            old_group_id = row["group_id"]
            preview, _ = evidence.preview_publish({"evidence_id": row["evidence_id"], "expected_heads": row["heads"]}, None)
            evidence.publish("group-history-publish", {"evidence_id": row["evidence_id"], "expected_heads": row["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
            deleted = run_cli(root, ["manage-group", "--stdin"], {"action": "delete", "group": "global"})
            self.assertIn(completed["job"]["job_id"], deleted["removed_feedback_jobs"])
            self.assertEqual(jobs.list()[0]["jobs"], [])
            self.assertEqual(evidence.view()["evidence"][0]["status"], "orphaned_group")
            run_cli(root, ["manage-group", "--stdin"], {"action": "create", "name": "global", "description": "重建组"})
            new_group_id = PreferenceStore(root).read_groups_v2()[0].id
            self.assertNotEqual(old_group_id, new_group_id)
            self.assertEqual(evidence.view()["evidence"][0]["status"], "orphaned_group")

    def test_group_delete_failure_restores_jobs_and_evidence_with_groups(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence, completed, _helper, jobs, _selection = self.complete_evidence(root)
            before_view = evidence.view()
            hook = root / "repo/.git/hooks/pre-commit"
            hook.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
            hook.chmod(0o755)
            failed = run_cli_process(root, ["manage-group", "--stdin"], {"action": "delete", "group": "global"})
            self.assertEqual(failed.returncode, 2)
            self.assertEqual(PreferenceStore(root).group_names(), ["global"])
            self.assertEqual(jobs.list()[0]["jobs"][0]["job_id"], completed["job"]["job_id"])
            self.assertEqual(evidence.view(), before_view)

    def test_cli_exposes_all_m4_evidence_actions_and_rejects_stale_heads(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            evidence, _completed, _helper, _jobs, _selection = self.complete_evidence(root)
            listed = run_cli(root, ["evidence", "--stdin"], request("list", "list"))
            row = listed["data"]["evidence"][0]
            detail = run_cli(root, ["evidence", "--stdin"], request("get", "get", payload={"evidence_id": row["evidence_id"]}))
            self.assertEqual(detail["data"]["evidence_id"], row["evidence_id"])
            impact = run_cli(root, ["evidence", "--stdin"], request("impact", "impact", payload={"evidence_id": row["evidence_id"]}))
            self.assertTrue(impact["data"]["candidate_impact_available"])
            self.assertEqual(impact["data"]["candidates"], [])
            self.assertEqual(impact["data"]["formal_rules"], [])
            withdrawn = run_cli(root, ["evidence", "--stdin"], request(
                "withdraw", "withdraw", expected_generation=listed["cas"]["generation"],
                payload={"evidence_id": row["evidence_id"], "expected_heads": row["heads"]},
            ))
            stale = run_cli_process(root, ["evidence", "--stdin"], request(
                "stale", "revise", expected_generation=withdrawn["cas"]["generation"],
                payload={"evidence_id": row["evidence_id"], "expected_heads": row["heads"], "patch": {"expected_behavior": "stale"}},
            ))
            self.assertEqual(stale.returncode, 2)
            self.assertEqual(json.loads(stale.stdout)["error"]["code"], "stale_generation")


if __name__ == "__main__":
    unittest.main()
