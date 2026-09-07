from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import _support
from wikiskill_preference_core.errors import PreferenceContractError, PreferenceError, PreferenceStorageError
from wikiskill_preference_core.evolution import build_proposal_input, build_proposal_prompt
from wikiskill_preference_core.evidence import EvidenceStore
from wikiskill_preference_core.jobs import FeedbackJobs
from wikiskill_preference_core.proposals import ProposalStore, apply_rollback, candidate_fingerprint, load_operation_records, operation_record, rollback_preview
from wikiskill_preference_core.store import PreferenceStore


class ProposalWorkflowTest(unittest.TestCase):
    @staticmethod
    def selection() -> dict[str, object]:
        return {
            "provider_source": "fake", "provider_id": "fake", "model_id": "fixture", "api_type": "fake",
            "endpoint_fingerprint": "sha256:" + hashlib.sha256(b"").hexdigest(), "thinking_level": "off",
            "max_tokens": 256, "timeout_seconds": 10, "config_version": 2,
        }

    def root(self, path: Path) -> tuple[str, dict[str, object]]:
        _support.run_cli(path, ["init"])
        config_path = path / "config.json"
        config = json.loads(config_path.read_text())
        config["provider"] = {"name": "fake", "model": "fixture", "api_key_env": "PREFERENCE_TEST_KEY", "thinking_level": "off", "max_tokens": 256, "timeout_seconds": 10}
        config["learning"]["extraction"]["enabled"] = True
        config["learning"]["proposals"]["enabled"] = True
        config_path.write_text(json.dumps(config))
        group_id = PreferenceStore(path).read_groups_v2()[0].id
        return group_id, self.selection()

    @staticmethod
    def extraction(group_id: str, *, weak: bool = False, expected: str = "回答保持简洁") -> str:
        return json.dumps({
            "group_id": group_id,
            "target": {"type": "assistant_text", "description": "回答表达"},
            "quote": {"source_alias": "assistant_result", "text": "很长的回答"},
            "observations": ["回答冗长"],
            "actual_behavior": "回答包含过多铺陈",
            "expected_behavior": expected,
            "task_summary": "回答一个中文请求",
            "evidence_summary": "用户希望结果简洁",
            "applicability": "一般中文答复",
            "nature": "preference",
            "specificity": "specific" if not weak else "generic",
            "confidence": .9,
            "needs_review": weak,
        }, ensure_ascii=False)

    @staticmethod
    def authorize_feedback(jobs: FeedbackJobs, feedback: str, snapshot: dict[str, object], selection: dict[str, object]) -> int:
        preview = jobs.preview({"feedback": feedback, "snapshot": snapshot, "model_selection": selection})[0]
        try:
            revision = jobs._consent()["revision"] + 1
        except Exception:
            revision = 1
        jobs.authorize({"revision": revision, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
        return revision

    def evidence(self, root: Path, group_id: str, selection: dict[str, object], index: int, *, task: str | None = None, weak: bool = False, feedback: str = "fix: 回答需要更简洁") -> dict[str, object]:
        jobs = FeedbackJobs(root)
        snapshot = {
            "session_id": f"session-{index}", "task_key": task or f"task-{index}",
            "user_entry_id": f"user-{index}", "assistant_entry_id": f"assistant-{index}",
            "user_text": "请回答", "assistant_text": "很长的回答", "origin_verified": True, "storage_mode": "ask",
        }
        revision = self.authorize_feedback(jobs, feedback, snapshot, selection)
        job = jobs.create(f"feedback-create-{index}-{hashlib.sha1((task or '').encode()).hexdigest()[:6]}", {
            "feedback": feedback, "group_id": group_id, "snapshot": snapshot,
            "model_selection": selection, "consent_revision": revision,
        })[0]["job"]
        claimed = jobs.claim({"job_id": job["job_id"], "owner_id": "feedback-owner", "consent_revision": revision, "model_selection": selection, "lease_seconds": 30})[0]["job"]
        return jobs.complete({
            "job_id": job["job_id"], "token": claimed["lease"]["token"], "input_digest": job["input_digest"],
            "model_selection": selection, "consent_revision": revision, "output": self.extraction(group_id, weak=weak),
        })[0]["evidence_revision"]

    def proposal(self, root: Path, group_id: str, selection: dict[str, object], changes: list[dict[str, object]], *, revision: int = 10) -> dict[str, object]:
        proposals = ProposalStore(root)
        preview = proposals.preview({"group_id": group_id, "model_selection": selection})[0]
        proposals.authorize({"revision": revision, "allowed": True, "stage": "proposals", "scope": "single", "group_ids": [group_id], "input_signature": preview["input_signature"], "model_selection": selection})
        job = proposals.generate(f"proposal-generate-{revision}", {
            "group_id": group_id, "model_selection": selection, "authorization_revision": revision, "explicit_retry": revision != 10,
        })[0]["job"]
        claimed = proposals.claim({"job_id": job["job_id"], "owner_id": "proposal-owner", "authorization_revision": revision, "model_selection": selection, "lease_seconds": 30})[0]["job"]
        return proposals.complete({
            "job_id": job["job_id"], "token": claimed["lease"]["token"], "input_digest": job["input_digest"],
            "input_signature": job["input_signature"], "model_selection": selection, "authorization_revision": revision,
            "output": json.dumps({"changes": changes}, ensure_ascii=False),
        })[0]["proposal"]

    @staticmethod
    def add(refs: list[dict[str, str]], text: str = "回答保持简洁。", *, opposing: list[dict[str, str]] | None = None) -> dict[str, object]:
        return {
            "action": "add", "rule_id": None, "expected_text": None, "proposed_text": text,
            "evidence_refs": refs, "opposing_evidence_refs": opposing or [], "rationale": "多个独立任务支持相同偏好",
            "applicability": "一般中文答复", "uncertainty": None, "old_rule_problem": None,
        }

    @staticmethod
    def refs(revisions: list[dict[str, object]]) -> list[dict[str, str]]:
        return [{"evidence_id": str(item["evidence_id"]), "revision_id": str(item["revision_id"])} for item in revisions]

    def test_real_feedback_extract_proposal_review_git_apply_and_runtime_rule(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            change = proposal["changes"][0]
            self.assertEqual(change["gate_result"]["classification"], "eligible_for_review")
            result = ProposalStore(root).accept("accept-a", {
                "proposal_id": proposal["proposal_id"], "generation": proposal["generation"],
                "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {},
            })[0]
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, ["回答保持简洁。"])  # runtime projection
            operation = load_operation_records(root)[-1]
            self.assertEqual(operation["operation_id"], result["operation_id"])
            self.assertEqual({"groups.json", f"changes/{result['operation_id']}.json"}, set(_support.git(root / "repo", "show", "--format=", "--name-only", result["commit"]).splitlines()))
            impact = ProposalStore(root).impact(str(revisions[0]["evidence_id"]))
            self.assertEqual(impact["candidates"][0]["proposal_id"], proposal["proposal_id"])
            self.assertEqual(impact["formal_rules"][0]["operation_id"], result["operation_id"])

    def test_add_gate_deduplicates_same_task_and_blocks_weak_or_opposed_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            same = [self.evidence(root, group_id, selection, index, task="same-task") for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(same))])
            self.assertEqual(proposal["changes"][0]["gate_result"]["support_task_count"], 1)
            self.assertEqual(proposal["changes"][0]["state"], "blocked")
            weak = self.evidence(root, group_id, selection, 3, weak=True)
            strong = self.evidence(root, group_id, selection, 4)
            opposed = self.proposal(root, group_id, selection, [self.add(self.refs([weak, strong]), opposing=self.refs([strong]))], revision=11)
            self.assertIn(opposed["changes"][0]["gate_result"]["classification"], {"insufficient_evidence", "needs_review"})
            with self.assertRaises(PreferenceContractError):
                ProposalStore(root)._parse_output(json.dumps({"changes": [self.add([{"evidence_id": "unknown", "revision_id": "unknown"}])]}), ProposalStore(root)._input(group_id, selection))

    def test_delete_model_opposition_is_not_user_confirmation_for_an_unrelated_rule(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            _support.run_cli(root, ["manage-group", "--stdin"], {"action": "add_rule", "group": "global", "rule": "始终用英文回答。"})
            rule = PreferenceStore(root).read_groups_v2()[0].rules[0]
            revisions = [self.evidence(root, group_id, selection, index, feedback="fix: 回答应更简洁") for index in range(3)]
            refs = self.refs(revisions)
            proposal = self.proposal(root, group_id, selection, [{
                "action": "delete", "rule_id": rule.id, "expected_text": rule.text, "proposed_text": None,
                "evidence_refs": refs, "opposing_evidence_refs": refs, "rationale": "模型声称这些反馈反对旧规则",
                "applicability": "一般答复", "uncertainty": None, "old_rule_problem": "模型声称旧规则有问题",
            }])
            change = proposal["changes"][0]
            self.assertEqual(change["gate_result"]["opposition_task_count"], 3)
            self.assertEqual(change["gate_result"]["explicit_opposition_count"], 0)
            self.assertEqual(change["state"], "blocked")
            with self.assertRaises(PreferenceContractError):
                ProposalStore(root).accept("unconfirmed-delete", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})
            detail = ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]
            self.assertEqual(detail["evidence_details"][0]["content"]["raw_feedback"], "fix: 回答应更简洁")
            self.assertEqual(change["rule_ref"]["text"], "始终用英文回答。")

    def test_replace_delete_and_noop_contracts_and_gates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            _support.run_cli(root, ["manage-group", "--stdin"], {"action": "add_rule", "group": "global", "rule": "回答越长越好。"})
            rule = PreferenceStore(root).read_groups_v2()[0].rules[0]
            replace_evidence = [self.evidence(root, group_id, selection, index) for index in range(2)]
            replace = {
                "action": "replace", "rule_id": rule.id, "expected_text": rule.text, "proposed_text": "回答保持简洁。",
                "evidence_refs": self.refs(replace_evidence), "opposing_evidence_refs": [], "rationale": "旧规则导致冗长",
                "applicability": "一般答复", "uncertainty": None, "old_rule_problem": "旧规则要求无必要扩写",
            }
            proposal = self.proposal(root, group_id, selection, [replace])
            self.assertEqual(proposal["changes"][0]["gate_result"]["classification"], "eligible_for_review")
            noop = self.proposal(root, group_id, selection, [{
                "action": "noop", "rule_id": None, "expected_text": None, "proposed_text": None, "evidence_refs": [],
                "opposing_evidence_refs": [], "rationale": "当前不应变化", "applicability": "当前组", "uncertainty": "证据不足", "old_rule_problem": None,
            }], revision=11)
            self.assertEqual(noop["changes"][0]["state"], "blocked")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            _support.run_cli(root, ["manage-group", "--stdin"], {"action": "add_rule", "group": "global", "rule": "回答越长越好。"})
            rule = PreferenceStore(root).read_groups_v2()[0].rules[0]
            revisions = [self.evidence(root, group_id, selection, index, feedback="fix: 明确反对回答越长越好") for index in range(3)]
            refs = self.refs(revisions)
            deletion = self.proposal(root, group_id, selection, [{
                "action": "delete", "rule_id": rule.id, "expected_text": rule.text, "proposed_text": None,
                "evidence_refs": refs, "opposing_evidence_refs": refs, "rationale": "三个任务反对旧规则",
                "applicability": "一般答复", "uncertainty": None, "old_rule_problem": "旧规则与明确偏好相反",
            }])
            change = deletion["changes"][0]
            gate = change["gate_result"]
            self.assertEqual((gate["opposition_task_count"], gate["explicit_opposition_count"]), (3, 0))
            self.assertEqual(gate["classification"], "insufficient_evidence")
            current = deletion
            for index, ref in enumerate(refs[:2]):
                current = ProposalStore(root).confirm_delete_opposition(f"confirm-delete-{index}", {
                    "proposal_id": current["proposal_id"], "generation": current["generation"],
                    "change_id": change["change_id"], "rule_ref": change["rule_ref"], "evidence_ref": ref,
                })[0]["proposal"]
            confirmed = current["changes"][0]["gate_result"]
            self.assertEqual(confirmed["explicit_opposition_count"], 2)
            self.assertEqual(confirmed["classification"], "eligible_for_review")
            accepted = ProposalStore(root).accept("accept-confirmed-delete", {"proposal_id": current["proposal_id"], "generation": current["generation"], "input_signature": current["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})[0]
            self.assertIsNotNone(accepted["commit"])
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, [])

    def test_delete_confirmation_is_invalidated_by_exact_rule_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            _support.run_cli(root, ["manage-group", "--stdin"], {"action": "add_rule", "group": "global", "rule": "始终用英文回答。"})
            rule = PreferenceStore(root).read_groups_v2()[0].rules[0]
            revisions = [self.evidence(root, group_id, selection, index, feedback="fix: 明确反对始终用英文回答") for index in range(3)]
            refs = self.refs(revisions)
            proposal = self.proposal(root, group_id, selection, [{"action": "delete", "rule_id": rule.id, "expected_text": rule.text, "proposed_text": None, "evidence_refs": refs, "opposing_evidence_refs": refs, "rationale": "反对旧规则", "applicability": "一般答复", "uncertainty": None, "old_rule_problem": "旧规则不符合偏好"}])
            change = proposal["changes"][0]; current = proposal
            for index, ref in enumerate(refs[:2]):
                current = ProposalStore(root).confirm_delete_opposition(f"invalidate-confirm-{index}", {"proposal_id": current["proposal_id"], "generation": current["generation"], "change_id": change["change_id"], "rule_ref": change["rule_ref"], "evidence_ref": ref})[0]["proposal"]
            _support.run_cli(root, ["manage-group", "--stdin"], {"action": "update_rule", "group": "global", "rule": rule.text, "replacement": "仅在用户要求时用英文回答。"})
            stale = ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]["proposal"]
            self.assertEqual(stale["changes"][0]["state"], "stale")
            with self.assertRaises(PreferenceError):
                ProposalStore(root).accept("stale-confirmed-delete", {"proposal_id": stale["proposal_id"], "generation": stale["generation"], "input_signature": stale["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})

    def test_builder_is_reproducible_and_caps_evidence_count_and_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            seed = self.evidence(root, group_id, selection, 0)
            revisions = []
            heads = []
            for index in range(101):
                revision = json.loads(json.dumps(seed))
                revision["evidence_id"] = f"evidence-batch-{index}"
                revision["revision_id"] = f"revision-batch-{index}"
                revision["origin_task_key"] = f"batch-task-{index}"
                revision["feedback_id"] = f"batch-feedback-{index}"
                revisions.append(revision)
                heads.append({"evidence_id": revision["evidence_id"], "heads": [revision["revision_id"]], "status": "active"})
            group = PreferenceStore(root).read_groups_v2()[0].to_dict()
            first = build_proposal_input(group, revisions, heads, [], [], selection)
            second = build_proposal_input(group, revisions, reversed(heads), [], [], selection)
            self.assertEqual(first["input_signature"], second["input_signature"])
            self.assertEqual(first["coverage"]["status"], "partial")
            self.assertGreater(first["coverage"]["included_evidence_count"], 0)
            self.assertLessEqual(first["coverage"]["included_evidence_count"], 100)
            self.assertLessEqual(first["coverage"]["included_bytes"], first["coverage"]["byte_budget"])
            self.assertEqual(build_proposal_prompt(first), build_proposal_prompt(second))

    def test_partial_coverage_is_preview_only_and_cannot_use_ordinary_accept(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            # A direct pre-history rule intentionally simulates an unavailable old source.
            PreferenceStore(root).add_group_rule("global", "旧来源不可用的规则。")
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            self.assertEqual(proposal["coverage"]["status"], "partial")
            self.assertEqual(proposal["changes"][0]["state"], "blocked")
            with self.assertRaises(PreferenceContractError):
                ProposalStore(root).accept("partial-accept", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [proposal["changes"][0]["change_id"]], "edited_texts": {}})

    def test_revoked_proposal_authorization_blocks_late_completion_without_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposals = ProposalStore(root); preview = proposals.preview({"group_id": group_id, "model_selection": selection})[0]
            proposals.authorize({"revision": 40, "allowed": True, "stage": "proposals", "scope": "single", "group_ids": [group_id], "input_signature": preview["input_signature"], "model_selection": selection})
            job = proposals.generate("late-generate", {"group_id": group_id, "model_selection": selection, "authorization_revision": 40, "explicit_retry": False})[0]["job"]
            claimed = proposals.claim({"job_id": job["job_id"], "owner_id": "late-owner", "authorization_revision": 40, "model_selection": selection, "lease_seconds": 30})[0]["job"]
            proposals.authorize({"revision": 41, "allowed": False, "stage": "proposals", "scope": "single", "group_ids": [group_id], "input_signature": preview["input_signature"], "model_selection": selection})
            output = json.dumps({"changes": [self.add(self.refs(revisions))]}, ensure_ascii=False)
            completed = proposals.complete({"job_id": job["job_id"], "token": claimed["lease"]["token"], "input_digest": job["input_digest"], "input_signature": job["input_signature"], "model_selection": selection, "authorization_revision": 40, "output": output})[0]
            self.assertTrue(completed["blocked"])
            self.assertEqual(ProposalStore(root).inspect()[0]["proposals"], [])
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, [])

    def test_same_signature_does_not_repeat_without_explicit_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            result = ProposalStore(root).generate("second-request", {"group_id": group_id, "model_selection": selection, "authorization_revision": 10, "explicit_retry": False})[0]
            self.assertTrue(result["idempotent"])
            self.assertEqual(result["proposal"]["proposal_id"], proposal["proposal_id"])
            self.assertFalse(result["charged"])

    def test_new_evidence_scope_is_stage_group_model_and_endpoint_bound(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            config_path = root / "config.json"
            config = json.loads(config_path.read_text())
            config["learning"]["proposal_trigger"] = "new_evidence"
            config_path.write_text(json.dumps(config))
            revision = self.evidence(root, group_id, selection, 0)
            proposals = ProposalStore(root)
            proposals.authorize({
                "revision": 50, "allowed": True, "stage": "proposals", "scope": "new_evidence",
                "group_ids": [group_id], "input_signature": None, "model_selection": selection,
            })
            triggered = proposals.trigger("auto-new-evidence", {
                "group_id": group_id,
                "evidence_ref": {"evidence_id": revision["evidence_id"], "revision_id": revision["revision_id"]},
            })[0]
            self.assertTrue(triggered["triggered"])
            self.assertEqual(triggered["job"]["state"], "queued")
            self.assertEqual(triggered["job"]["model_selection"], selection)
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, [])
            consent = proposals._consent()
            self.assertEqual((consent["stage"], consent["scope"], consent["group_ids"]), ("proposals", "new_evidence", [group_id]))
            changed_endpoint = {**selection, "endpoint_fingerprint": "sha256:" + "a" * 64}
            blocked = proposals.generate("wrong-endpoint", {
                "group_id": group_id, "model_selection": changed_endpoint,
                "authorization_revision": 50, "explicit_retry": True,
            })[0]["job"]
            self.assertEqual((blocked["state"], blocked["error_code"]), ("blocked_consent", "proposal_send_not_authorized"))

    def test_shared_worker_and_budget_with_separate_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposals = ProposalStore(root); preview = proposals.preview({"group_id": group_id, "model_selection": selection})[0]
            # Feedback authorization alone cannot create a sendable proposal job.
            blocked = proposals.generate("blocked-generate", {"group_id": group_id, "model_selection": selection, "authorization_revision": 1, "explicit_retry": False})[0]["job"]
            self.assertEqual(blocked["state"], "blocked_consent")
            proposals.authorize({"revision": 20, "allowed": True, "stage": "proposals", "scope": "single", "group_ids": [group_id], "input_signature": preview["input_signature"], "model_selection": selection})
            queued = proposals.generate("authorized-generate", {"group_id": group_id, "model_selection": selection, "authorization_revision": 20, "explicit_retry": False})[0]["job"]
            jobs = FeedbackJobs(root)
            snapshot = {"session_id": "busy-session", "task_key": "busy-task", "user_entry_id": "busy-user", "assistant_entry_id": "busy-assistant", "user_text": "请回答", "assistant_text": "很长的回答", "origin_verified": True, "storage_mode": "ask"}
            consent_revision = self.authorize_feedback(jobs, "fix: 简洁", snapshot, selection)
            feedback = jobs.create("busy-feedback", {"feedback": "fix: 简洁", "group_id": group_id, "snapshot": snapshot, "model_selection": selection, "consent_revision": consent_revision})[0]["job"]
            feedback_claim = jobs.claim({"job_id": feedback["job_id"], "owner_id": "feedback-busy", "consent_revision": consent_revision, "model_selection": selection, "lease_seconds": 30})[0]["job"]
            with self.assertRaises(PreferenceError) as busy:
                proposals.claim({"job_id": queued["job_id"], "owner_id": "proposal", "authorization_revision": 20, "model_selection": selection, "lease_seconds": 30})
            self.assertEqual(busy.exception.code, "worker_busy")
            with self.assertRaises(PreferenceContractError):
                proposals.authorize_send({"job_id": queued["job_id"], "token": feedback_claim["lease"]["token"], "model_selection": selection, "authorization_revision": 20, "endpoint_fingerprint": selection["endpoint_fingerprint"]})

    def test_feedback_and_proposal_claims_share_one_worker_across_processes_and_recover_fairly(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            snapshot = {
                "session_id": "process-session", "task_key": "process-task", "user_entry_id": "process-user",
                "assistant_entry_id": "process-assistant", "user_text": "请回答", "assistant_text": "很长的回答",
                "origin_verified": True, "storage_mode": "ask",
            }
            feedback_jobs = FeedbackJobs(root)
            feedback_revision = self.authorize_feedback(feedback_jobs, "fix: 简洁", snapshot, selection)
            feedback = feedback_jobs.create("process-feedback", {
                "feedback": "fix: 简洁", "group_id": group_id, "snapshot": snapshot,
                "model_selection": selection, "consent_revision": feedback_revision,
            })[0]["job"]
            proposals = ProposalStore(root)
            preview = proposals.preview({"group_id": group_id, "model_selection": selection})[0]
            proposals.authorize({
                "revision": 70, "allowed": True, "stage": "proposals", "scope": "single",
                "group_ids": [group_id], "input_signature": preview["input_signature"], "model_selection": selection,
            })
            proposal = proposals.generate("process-proposal", {
                "group_id": group_id, "model_selection": selection,
                "authorization_revision": 70, "explicit_retry": False,
            })[0]["job"]
            feedback_generation = feedback_jobs.list()[1]["generation"]
            proposal_generation = proposals.job_list()[1]["generation"]
            requests = [
                ("learning-job", _support.request("process-claim-feedback", "claim", expected_generation=feedback_generation, payload={
                    "job_id": feedback["job_id"], "owner_id": "process-feedback-owner", "consent_revision": feedback_revision,
                    "model_selection": selection, "lease_seconds": 30,
                })),
                ("proposal-job", _support.request("process-claim-proposal", "claim", expected_generation=proposal_generation, payload={
                    "job_id": proposal["job_id"], "owner_id": "process-proposal-owner", "authorization_revision": 70,
                    "model_selection": selection, "lease_seconds": 30,
                })),
            ]
            processes = [subprocess.Popen(
                ["python3", str(_support.CLI), command, "--stdin", "--data-root", str(root)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            ) for command, _request in requests]
            for process, (_command, request) in zip(processes, requests):
                assert process.stdin is not None
                process.stdin.write(json.dumps(request))
                process.stdin.close()
                process.stdin = None
            results = []
            for process in processes:
                stdout, stderr = process.communicate()
                results.append((process.returncode, json.loads(stdout), stderr))
            self.assertEqual(sorted(code for code, _data, _stderr in results), [0, 2])
            failure = next(data for code, data, _stderr in results if code == 2)
            self.assertEqual(failure["error"]["code"], "worker_busy")
            feedback_current = FeedbackJobs(root).get({"job_id": feedback["job_id"]})[0]["job"]
            proposal_current = ProposalStore(root)._find_job(ProposalStore(root)._jobs(), proposal["job_id"])
            if feedback_current["state"] == "running":
                FeedbackJobs(root).cancel_lease({"job_id": feedback["job_id"], "token": feedback_current["lease"]["token"]})
                recovered = ProposalStore(root).claim({
                    "job_id": proposal["job_id"], "owner_id": "recovered-proposal", "authorization_revision": 70,
                    "model_selection": selection, "lease_seconds": 30,
                })[0]["job"]
                self.assertEqual(recovered["state"], "running")
            else:
                ProposalStore(root).cancel_lease({"job_id": proposal["job_id"], "token": proposal_current["lease"]["token"]})
                recovered = FeedbackJobs(root).claim({
                    "job_id": feedback["job_id"], "owner_id": "recovered-feedback", "consent_revision": feedback_revision,
                    "model_selection": selection, "lease_seconds": 30,
                })[0]["job"]
                self.assertEqual(recovered["state"], "running")

    def test_feedback_and_proposal_claims_share_one_daily_request_budget(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            config_path = root / "config.json"; config = json.loads(config_path.read_text()); config["learning"]["max_requests_per_day"] = 3; config_path.write_text(json.dumps(config))
            proposals = ProposalStore(root); preview = proposals.preview({"group_id": group_id, "model_selection": selection})[0]
            proposals.authorize({"revision": 30, "allowed": True, "stage": "proposals", "scope": "single", "group_ids": [group_id], "input_signature": preview["input_signature"], "model_selection": selection})
            job = proposals.generate("budget-proposal", {"group_id": group_id, "model_selection": selection, "authorization_revision": 30, "explicit_retry": False})[0]["job"]
            claimed = proposals.claim({"job_id": job["job_id"], "owner_id": "proposal-budget", "authorization_revision": 30, "model_selection": selection, "lease_seconds": 30})[0]["job"]
            proposals.cancel_lease({"job_id": job["job_id"], "token": claimed["lease"]["token"]})
            snapshot = {"session_id": "budget-session", "task_key": "budget-task", "user_entry_id": "budget-user", "assistant_entry_id": "budget-assistant", "user_text": "请回答", "assistant_text": "很长的回答", "origin_verified": True, "storage_mode": "ask"}
            feedback_jobs = FeedbackJobs(root)
            consent_revision = self.authorize_feedback(feedback_jobs, "fix: 简洁", snapshot, selection)
            feedback = feedback_jobs.create("budget-feedback", {"feedback": "fix: 简洁", "group_id": group_id, "snapshot": snapshot, "model_selection": selection, "consent_revision": consent_revision})[0]["job"]
            blocked = feedback_jobs.claim({"job_id": feedback["job_id"], "owner_id": "feedback-budget", "consent_revision": consent_revision, "model_selection": selection, "lease_seconds": 30})[0]["job"]
            self.assertEqual((blocked["state"], blocked["error_code"]), ("blocked_budget", "daily_budget_exhausted"))

    def test_rejection_keeps_private_reason_local_and_syncs_only_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            reason = "这条候选过度泛化了我的私有场景"
            result = ProposalStore(root).reject("reject-private", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "change_ids": [proposal["changes"][0]["change_id"]], "reason": reason})[0]
            self.assertIn(reason, (root / "local/decisions.json").read_text())
            operation_text = (root / "repo/changes" / f"{result['operation_id']}.json").read_text()
            self.assertNotIn(reason, operation_text)
            operation = json.loads(operation_text)
            self.assertIsNone(operation["proposal_id"])
            self.assertEqual(operation["change_ids"], [])
            self.assertEqual(operation["evidence_refs"], [])
            self.assertEqual(len(operation["decision_fingerprints"]), 1)
            self.assertTrue(operation["decision_fingerprints"][0].startswith("sha256:"))

    def test_multi_reject_fingerprints_suppress_each_candidate_on_second_device(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); device_a = base / "a"; device_b = base / "b"; remote = base / "remote.git"
            group_id, selection = self.root(device_a)
            revisions = [self.evidence(device_a, group_id, selection, index) for index in range(2)]
            evidence = EvidenceStore(device_a)
            for revision in revisions:
                detail = evidence.get(revision["evidence_id"])[0]
                preview, _ = evidence.preview_publish({"evidence_id": revision["evidence_id"], "expected_heads": detail["heads"]}, None)
                evidence.publish(f"publish-{revision['evidence_id']}", {"evidence_id": revision["evidence_id"], "expected_heads": detail["heads"], "preview_digest": preview["preview_digest"], "revision_ids": preview["revision_ids"]}, None)
            refs = self.refs(revisions)
            proposal = self.proposal(device_a, group_id, selection, [self.add(refs, "候选 A。"), self.add(list(reversed(refs)), "候选 B。")])
            rejected = ProposalStore(device_a).reject("reject-two", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "change_ids": [item["change_id"] for item in proposal["changes"]], "reason": "两项都不采用"})[0]
            operation = next(item for item in load_operation_records(device_a) if item["operation_id"] == rejected["operation_id"])
            self.assertEqual(len(operation["decision_fingerprints"]), 2)
            subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            subprocess.run(["git", "-C", str(device_a / "repo"), "push", "-u", "origin", "HEAD"], check=True, stdout=subprocess.DEVNULL)
            device_b.mkdir(); subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            group_b, selection_b = self.root(device_b)
            repeated = self.proposal(device_b, group_b, selection_b, [self.add(list(reversed(refs)), "候选 A。"), self.add(refs, "候选 B。")])
            self.assertEqual([item["state"] for item in repeated["changes"]], ["blocked", "blocked"])
            self.assertTrue(all("duplicate_prior_decision" in item["gate_result"]["reasons"] for item in repeated["changes"]))

    def test_applied_original_candidate_remains_suppressed_after_edited_accept_and_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); root = base / "a"; group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            evidence = EvidenceStore(root)
            for revision in revisions:
                detail = evidence.get(revision["evidence_id"])[0]
                publish_preview, _ = evidence.preview_publish({"evidence_id": revision["evidence_id"], "expected_heads": detail["heads"]}, None)
                evidence.publish(f"apply-publish-{revision['evidence_id']}", {"evidence_id": revision["evidence_id"], "expected_heads": detail["heads"], "preview_digest": publish_preview["preview_digest"], "revision_ids": publish_preview["revision_ids"]}, None)
            refs = self.refs(revisions)
            proposal = self.proposal(root, group_id, selection, [self.add(refs, "模型原提案。")])
            change = proposal["changes"][0]
            applied = ProposalStore(root).accept("edited-apply", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {change["change_id"]: "用户修改后正文。"}})[0]
            operation = next(item for item in load_operation_records(root) if item["operation_id"] == applied["operation_id"])
            self.assertEqual(operation["decision_fingerprints"], [candidate_fingerprint(group_id, change["action"], change["rule_ref"], change["proposed_text"], change["evidence_refs"], change["opposing_evidence_refs"])])
            preview = rollback_preview(root)
            apply_rollback(root, {"expected_operation_id": preview["target_operation_id"], "expected_head": preview["expected_head"]})
            remote = base / "applied-remote.git"; device_b = base / "applied-device-b"
            subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "-C", str(root / "repo"), "remote", "add", "origin", str(remote)], check=True)
            subprocess.run(["git", "-C", str(root / "repo"), "push", "-u", "origin", "HEAD"], check=True, stdout=subprocess.DEVNULL)
            device_b.mkdir(); subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            group_b, selection_b = self.root(device_b)
            repeated = self.proposal(device_b, group_b, selection_b, [self.add(list(reversed(refs)), "模型原提案。")], revision=11)
            self.assertEqual(repeated["changes"][0]["state"], "blocked")
            self.assertIn("duplicate_prior_decision", repeated["changes"][0]["gate_result"]["reasons"])

    def test_withdrawal_and_new_evidence_make_pending_candidate_stale(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            evidence = EvidenceStore(root); detail = evidence.get(revisions[0]["evidence_id"])[0]
            evidence.withdraw("withdraw-after-proposal", {"evidence_id": revisions[0]["evidence_id"], "expected_heads": detail["heads"]}, None)
            current = ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]["proposal"]
            self.assertEqual(current["changes"][0]["state"], "stale")

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            self.evidence(root, group_id, selection, 3)
            current = ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]["proposal"]
            self.assertEqual(current["changes"][0]["state"], "stale")

    def test_defer_resume_and_reject_do_not_self_stale_other_batch_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions), "规则一。"), self.add(self.refs(revisions), "规则二。"), self.add(self.refs(revisions), "规则三。")])
            first, second, third = proposal["changes"]
            deferred = ProposalStore(root).defer("defer-first", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "change_ids": [first["change_id"]]})[0]["proposal"]
            current = ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]["proposal"]
            self.assertEqual([item["state"] for item in current["changes"]], ["deferred", "pending_review", "pending_review"])
            resumed = ProposalStore(root).resume("resume-first", {"proposal_id": deferred["proposal_id"], "generation": current["generation"], "change_ids": [first["change_id"]]})[0]["proposal"]
            rejected = ProposalStore(root).reject("reject-first", {"proposal_id": resumed["proposal_id"], "generation": resumed["generation"], "change_ids": [first["change_id"]], "reason": "暂存后决定拒绝"})[0]["proposal"]
            after_reject = ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]["proposal"]
            self.assertEqual([item["state"] for item in after_reject["changes"]], ["rejected", "pending_review", "pending_review"])
            applied = ProposalStore(root).accept("accept-second", {"proposal_id": rejected["proposal_id"], "generation": after_reject["generation"], "input_signature": proposal["input_signature"], "change_ids": [second["change_id"]], "edited_texts": {}})[0]["proposal"]
            self.assertEqual([item["state"] for item in applied["changes"]], ["rejected", "applied", "stale"])
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, ["规则二。"])

    def test_external_proposal_decision_still_invalidates_an_older_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            first = self.proposal(root, group_id, selection, [self.add(self.refs(revisions), "外部决定一。")])
            second = self.proposal(root, group_id, selection, [self.add(self.refs(revisions), "外部决定二。")], revision=11)
            ProposalStore(root).reject("external-reject", {"proposal_id": first["proposal_id"], "generation": first["generation"], "change_ids": [first["changes"][0]["change_id"]], "reason": "改变后续审核历史"})
            stale = ProposalStore(root).get({"proposal_id": second["proposal_id"]})[0]["proposal"]
            self.assertEqual(stale["changes"][0]["state"], "stale")

    def test_accept_is_semantically_idempotent_and_multi_apply_stales_unselected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions), "规则一。"), self.add(self.refs(revisions), "规则二。"), self.add(self.refs(revisions), "规则三。")])
            first, second, third = proposal["changes"]
            result = ProposalStore(root).accept("accept-first", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [first["change_id"], second["change_id"]], "edited_texts": {second["change_id"]: "用户修改规则二。"}})[0]
            repeated = ProposalStore(root).accept("different-request-id", {"proposal_id": proposal["proposal_id"], "generation": 999, "input_signature": proposal["input_signature"], "change_ids": [first["change_id"], second["change_id"]], "edited_texts": {}})[0]
            self.assertTrue(repeated["idempotent"])
            self.assertEqual(repeated["operation_id"], result["operation_id"])
            current = ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]["proposal"]
            self.assertEqual(next(item for item in current["changes"] if item["change_id"] == third["change_id"])["state"], "stale")
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, ["规则一。", "用户修改规则二。"])

    def test_cli_apply_push_failure_keeps_local_commit_ahead(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            config_path = root / "config.json"; config = json.loads(config_path.read_text()); config["git_auto_push"] = True; config_path.write_text(json.dumps(config))
            _support.git(root / "repo", "remote", "add", "origin", str(root / "missing.git"))
            state = ProposalStore(root)._state()["collection_revision"]
            response = _support.run_cli(root, ["proposal", "--stdin"], _support.request("cli-accept-push", "accept", expected_generation=state, payload={"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [proposal["changes"][0]["change_id"]], "edited_texts": {}}))
            self.assertTrue(response["ok"])
            self.assertFalse(response["data"]["pushed"])
            self.assertIn("push_error", response["data"])
            self.assertEqual(response["data"]["sync_state"], "ahead")
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, ["回答保持简洁。"])

    def test_unknown_groups_commit_without_operation_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); self.root(root)
            groups = json.loads((root / "repo/groups.json").read_text())
            groups["groups"][0]["description"] = "外部未知修改"
            (root / "repo/groups.json").write_text(json.dumps(groups))
            _support.git(root / "repo", "add", "groups.json")
            _support.git(root / "repo", "commit", "-m", "user: unknown groups mutation")
            with self.assertRaises(PreferenceError):
                load_operation_records(root)

    def test_forged_operation_commit_cannot_publish_a_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            change = proposal["changes"][0]
            groups = {"schema_version": 2, "groups": [item.to_dict() for item in PreferenceStore(root).read_groups_v2()]}
            transaction_id = "txn-forged-operation"
            forged = operation_record(
                operation_id="operation-forged-receipt", transaction_id=transaction_id,
                kind="proposal_apply", source_kind="proposal_accept", before_groups=groups, after_groups=groups,
                effects=[], proposal_id=proposal["proposal_id"], change_ids=[change["change_id"]],
                evidence_refs=change["evidence_refs"],
                decision_fingerprints=[candidate_fingerprint(group_id, change["action"], change["rule_ref"], change["proposed_text"], change["evidence_refs"], change["opposing_evidence_refs"])],
            )
            path = root / "repo/changes/operation-forged-receipt.json"; path.parent.mkdir(exist_ok=True); path.write_text(json.dumps(forged))
            _support.git(root / "repo", "add", "changes/operation-forged-receipt.json")
            _support.git(root / "repo", "commit", "-m", "forged receipt without transaction marker")
            with self.assertRaises(PreferenceError):
                ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})
            unchanged = ProposalStore(root).inspect()[0]["proposals"][0]
            self.assertEqual(unchanged["changes"][0]["state"], "pending_review")
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, [])
            self.assertFalse((root / "local/proposal-receipts.json").exists())

    def test_tampered_operation_effect_or_digest_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            change = proposal["changes"][0]
            result = ProposalStore(root).accept("tamper-source", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})[0]
            path = root / "repo/changes" / f"{result['operation_id']}.json"
            operation = json.loads(path.read_text()); operation["groups_after_digest"] = "sha256:" + "0" * 64; operation["effects"][-1]["after_rule"]["text"] = "篡改正文"; path.write_text(json.dumps(operation))
            _support.git(root / "repo", "add", f"changes/{path.name}")
            _support.git(root / "repo", "commit", "--amend", "--no-edit")
            self.assertEqual(_support.git(root / "repo", "status", "--porcelain"), "")
            with self.assertRaises(PreferenceError):
                load_operation_records(root)

    def test_commit_failure_restores_and_receipt_failure_recovers_from_operation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            change = proposal["changes"][0]
            hook = root / "repo/.git/hooks/pre-commit"; hook.write_text("#!/bin/sh\nexit 1\n"); hook.chmod(0o755)
            with self.assertRaises(PreferenceError):
                ProposalStore(root).accept("hook-failure", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, [])
            self.assertEqual(_support.git(root / "repo", "status", "--porcelain"), "")
            hook.unlink()
            store = ProposalStore(root)
            original_commit = store._commit
            with patch.object(store, "_commit", side_effect=PreferenceStorageError("receipt crash")):
                applied = store.accept("receipt-crash", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {change["change_id"]: "用户最终正文。"}})[0]
            self.assertTrue(applied["receipt_pending_recovery"])
            self.assertEqual(PreferenceStore(root).read_groups()[0].rules, ["用户最终正文。"])
            recovered = ProposalStore(root).list()[0]["proposals"][0]
            review = recovered["changes"][0]["review"]
            self.assertEqual((review["decision"], review["final_text"]), ("accepted_with_edits", "用户最终正文。"))
            self.assertTrue((root / "local/proposal-receipts.json").exists())
            self.assertIsNotNone(original_commit)

    def test_receipt_recovery_remains_valid_after_local_operation_rebase(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); device_a = base / "a"; device_b = base / "b"; remote = base / "remote.git"
            group_id, selection = self.root(device_a)
            revisions = [self.evidence(device_a, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(device_a, group_id, selection, [self.add(self.refs(revisions))])
            subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            subprocess.run(["git", "-C", str(device_a / "repo"), "push", "-u", "origin", "HEAD"], check=True, stdout=subprocess.DEVNULL)
            device_b.mkdir(); subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            _support.run_cli(device_b, ["init"])
            version_path = device_b / "repo/version.json"
            version = json.loads(version_path.read_text()); version["model"] = "upstream-independent-update"; version_path.write_text(json.dumps(version))
            _support.git(device_b / "repo", "add", "version.json")
            _support.git(device_b / "repo", "commit", "-m", "user: independent version update")
            subprocess.run(["git", "-C", str(device_b / "repo"), "push"], check=True, stdout=subprocess.DEVNULL)
            change = proposal["changes"][0]
            store = ProposalStore(device_a)
            with patch.object(store, "_commit", side_effect=PreferenceStorageError("receipt crash before rebase")):
                applied = store.accept("receipt-rebase", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})[0]
            self.assertTrue(applied["receipt_pending_recovery"])
            _support.run_cli(device_a, ["sync"])
            recovered = ProposalStore(device_a).list()[0]["proposals"][0]
            self.assertEqual(recovered["changes"][0]["state"], "applied")
            self.assertEqual(PreferenceStore(device_a).read_version()["model"], "upstream-independent-update")

    def test_two_devices_report_missing_private_sources_without_inventing_support(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary); device_a = base / "a"; device_b = base / "b"; remote = base / "remote.git"
            group_id, selection = self.root(device_a)
            revisions = [self.evidence(device_a, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(device_a, group_id, selection, [self.add(self.refs(revisions))])
            change = proposal["changes"][0]
            ProposalStore(device_a).accept("device-a-accept", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})
            subprocess.run(["git", "init", "--bare", str(remote)], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            subprocess.run(["git", "-C", str(device_a / "repo"), "push", "-u", "origin", "HEAD"], check=True, stdout=subprocess.DEVNULL)
            device_b.mkdir(); subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            _support.run_cli(device_b, ["init"])
            config = json.loads((device_b / "config.json").read_text()); config["provider"] = {"name": "fake", "model": "fixture", "api_key_env": "PREFERENCE_TEST_KEY", "thinking_level": "off", "max_tokens": 256, "timeout_seconds": 10}; config["learning"]["proposals"]["enabled"] = True; (device_b / "config.json").write_text(json.dumps(config))
            built = ProposalStore(device_b)._input(group_id, selection)
            self.assertEqual(built["coverage"]["status"], "partial")
            self.assertIn("rule_source_revisions_unavailable", built["coverage"]["reasons"])
            self.assertEqual(EvidenceStore(device_b).view()["evidence"], [])
            impact = ProposalStore(device_b).impact(str(revisions[0]["evidence_id"]))
            self.assertEqual(impact["formal_rules"][0]["source_visibility"], "source_only_on_origin_device")

    def test_rollback_preview_expected_target_prevents_racing_undo_and_preserves_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); group_id, selection = self.root(root)
            revisions = [self.evidence(root, group_id, selection, index) for index in range(2)]
            proposal = self.proposal(root, group_id, selection, [self.add(self.refs(revisions))])
            change = proposal["changes"][0]
            ProposalStore(root).accept("accept", {"proposal_id": proposal["proposal_id"], "generation": proposal["generation"], "input_signature": proposal["input_signature"], "change_ids": [change["change_id"]], "edited_texts": {}})
            preview = rollback_preview(root)
            _support.run_cli(root, ["remember", "--stdin"], {"group": "global", "rule": "竞态新规则。", "task_id": None})
            with self.assertRaises(PreferenceError):
                apply_rollback(root, {"expected_operation_id": preview["target_operation_id"], "expected_head": preview["expected_head"]})
            latest = rollback_preview(root)
            result = apply_rollback(root, {"expected_operation_id": latest["target_operation_id"], "expected_head": latest["expected_head"]})
            self.assertEqual(result["reverts_operation_id"], latest["target_operation_id"])
            self.assertEqual(len(EvidenceStore(root).view()["evidence"]), 2)
            self.assertEqual(ProposalStore(root).get({"proposal_id": proposal["proposal_id"]})[0]["proposal"]["state"], "applied")


if __name__ == "__main__":
    unittest.main()
