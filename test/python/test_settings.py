from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import _support
from wikiskill_preference_core.jobs import FeedbackJobs
from wikiskill_preference_core.proposals import ProposalStore
from wikiskill_preference_core.store import PreferenceStore


class SettingsContractTest(unittest.TestCase):
    @staticmethod
    def selection(*, model: str = "fixture", max_tokens: int = 128) -> dict[str, object]:
        return {
            "provider_source": "fake",
            "provider_id": "fake",
            "model_id": model,
            "api_type": "fake",
            "endpoint_fingerprint": "sha256:" + hashlib.sha256(b"").hexdigest(),
            "thinking_level": "off",
            "max_tokens": max_tokens,
            "timeout_seconds": 10,
            "config_version": 0,
        }

    @staticmethod
    def update(root: Path, generation: int, patch: dict[str, object], **actions: bool) -> dict[str, object]:
        return _support.run_cli(
            root,
            ["settings", "--stdin"],
            _support.request(
                f"settings-{generation}-{len(json.dumps(patch))}",
                "update",
                expected_generation=generation,
                payload={
                    "patch": patch,
                    "revoke_feedback_authorization": actions.get("revoke_feedback", False),
                    "revoke_proposal_authorization": actions.get("revoke_proposal", False),
                    "clear_snapshots": actions.get("clear_snapshots", False),
                },
            ),
        )

    def test_get_update_cas_normalizes_independent_stage_inheritance(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _support.run_cli(root, ["init"])
            current = _support.run_cli(root, ["settings", "--stdin"], _support.request("settings-get", "get"))
            self.assertEqual(current["cas"]["generation"], 0)
            self.assertEqual(current["data"]["config"]["learning"]["proposal_trigger"], "manual")
            updated = self.update(root, 0, {
                "provider": {
                    "name": "fake", "model": "extractor", "api_key_env": "PREFERENCE_TEST_KEY",
                    "thinking_level": "off", "timeout_seconds": 30, "max_tokens": 1200,
                },
                "learning": {
                    "extraction": {
                        "enabled": True, "thinking_level": "low", "timeout_seconds": 45,
                        "max_tokens": 900,
                    },
                    "proposals": {
                        "enabled": True,
                        "provider": {
                            "name": "fake", "model": "proposer", "api_key_env": "PREFERENCE_TEST_KEY",
                            "thinking_level": "high", "timeout_seconds": 90, "max_tokens": 4096,
                        },
                    },
                    "proposal_trigger": "new_evidence",
                    "max_attempts": 2,
                    "max_requests_per_day": 9,
                },
                "privacy": {"context_mode": "local_only", "snapshot_retention_days": 3},
            })
            config = updated["data"]["config"]
            self.assertEqual(updated["cas"]["generation"], 1)
            self.assertEqual(config["provider"]["max_tokens"], 1200)
            self.assertEqual(config["learning"]["extraction"]["provider"], "inherit")
            self.assertEqual(config["learning"]["extraction"]["max_tokens"], 900)
            self.assertEqual(config["learning"]["proposals"]["provider"]["model"], "proposer")
            loaded = PreferenceStore(root).config
            self.assertEqual(loaded.stage_provider("extraction")["model"], "extractor")
            self.assertEqual(loaded.stage_provider("extraction")["thinking_level"], "low")
            self.assertEqual(loaded.stage_provider("proposals")["model"], "proposer")
            self.assertEqual(loaded.stage_provider("proposals")["max_tokens"], 4096)

    def test_invalid_fields_ranges_and_stale_cas_fail_without_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _support.run_cli(root, ["init"])
            config_path = root / "config.json"
            before = config_path.read_bytes()
            invalid = [
                {"learning": {"unknown": True}},
                {"learning": {"extraction": {"timeout_seconds": 0}}},
                {"learning": {"proposals": {"max_tokens": 0}}},
                {"learning": {"max_attempts": 4}},
                {"privacy": {"snapshot_retention_days": 0}},
                {"provider": {"name": "pi", "thinking_level": "inherit", "timeout_seconds": 300, "max_tokens": 2048, "secret": "x"}},
            ]
            for index, patch in enumerate(invalid):
                result = _support.run_cli_process(
                    root,
                    ["settings", "--stdin"],
                    _support.request(
                        f"invalid-{index}", "update", expected_generation=0,
                        payload={"patch": patch, "revoke_feedback_authorization": False,
                                 "revoke_proposal_authorization": False, "clear_snapshots": False},
                    ),
                )
                self.assertEqual(result.returncode, 2)
                self.assertIn(json.loads(result.stdout)["error"]["code"], {"invalid_contract", "invalid_config"})
                self.assertEqual(config_path.read_bytes(), before)
                self.assertFalse((root / "local/settings-state.json").exists())
            self.update(root, 0, {"capture_user_edits": False})
            after = config_path.read_bytes()
            stale = _support.run_cli_process(
                root,
                ["settings", "--stdin"],
                _support.request(
                    "stale-settings", "update", expected_generation=0,
                    payload={"patch": {"enabled": False}, "revoke_feedback_authorization": False,
                             "revoke_proposal_authorization": False, "clear_snapshots": False},
                ),
            )
            self.assertEqual(stale.returncode, 2)
            self.assertEqual(json.loads(stale.stdout)["error"]["code"], "generation_conflict")
            self.assertEqual(config_path.read_bytes(), after)

    def test_disable_revoke_and_clear_snapshot_stop_jobs_but_preserve_feedback_and_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _support.run_cli(root, ["init"])
            config_path = root / "config.json"
            config = json.loads(config_path.read_text())
            config["provider"] = {
                "name": "fake", "model": "fixture", "api_key_env": "PREFERENCE_TEST_KEY",
                "thinking_level": "off", "timeout_seconds": 10, "max_tokens": 128,
            }
            config["learning"]["extraction"]["enabled"] = True
            config_path.write_text(json.dumps(config))
            group_id = PreferenceStore(root).read_groups_v2()[0].id
            selection = self.selection()
            jobs = FeedbackJobs(root)
            snapshot = {
                "session_id": "settings-session", "task_key": "settings-task", "user_entry_id": "settings-user",
                "assistant_entry_id": "settings-assistant", "user_text": "请简洁回答", "assistant_text": "这是较长结果",
                "origin_verified": True, "storage_mode": "ask",
            }
            preview = jobs.preview({"feedback": "fix: 请简洁", "snapshot": snapshot, "model_selection": selection})[0]
            jobs.authorize({"revision": 1, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
            created = jobs.create("settings-feedback", {
                "feedback": "fix: 请简洁", "group_id": group_id, "snapshot": snapshot,
                "model_selection": selection, "consent_revision": 1,
            })[0]["job"]
            running = jobs.claim({
                "job_id": created["job_id"], "owner_id": "settings-worker", "consent_revision": 1,
                "model_selection": selection, "lease_seconds": 30,
            })[0]["job"]
            self.assertTrue((root / "local/worker.json").exists())
            disabled = self.update(root, 0, {"learning": {"extraction": {"enabled": False}}})
            stopped = FeedbackJobs(root).get({"job_id": created["job_id"]})[0]["job"]
            self.assertEqual((stopped["state"], stopped["error_code"]), ("blocked_config", "stage_disabled"))
            self.assertEqual(stopped["feedback"], "fix: 请简洁")
            self.assertFalse((root / "local/worker.json").exists())
            self.assertTrue((root / "local/feedback-snapshots" / f"{created['job_id']}.json").exists())
            late = {
                "job_id": created["job_id"], "token": running["lease"]["token"],
                "input_digest": running["input_digest"], "model_selection": selection,
                "consent_revision": 1, "output": "{}",
            }
            with self.assertRaises(Exception):
                FeedbackJobs(root).complete(late)
            cleared = self.update(
                root, disabled["cas"]["generation"], {}, revoke_feedback=True, clear_snapshots=True,
            )
            retained = FeedbackJobs(root).get({"job_id": created["job_id"]})[0]["job"]
            self.assertEqual(retained["feedback"], "fix: 请简洁")
            self.assertIsNone(retained["snapshot_ref"])
            self.assertEqual(cleared["data"]["snapshot_count"], 0)
            self.assertIsNone(cleared["data"]["feedback_authorization"])

    def test_single_proposal_scope_cannot_expand_to_future_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _support.run_cli(root, ["init"])
            config_path = root / "config.json"
            config = json.loads(config_path.read_text())
            config["provider"] = {
                "name": "fake", "model": "fixture", "api_key_env": "PREFERENCE_TEST_KEY",
                "thinking_level": "off", "timeout_seconds": 10, "max_tokens": 128,
            }
            config["learning"]["proposals"]["enabled"] = True
            config["learning"]["proposal_trigger"] = "new_evidence"
            config_path.write_text(json.dumps(config))
            group_id = PreferenceStore(root).read_groups_v2()[0].id
            proposals = ProposalStore(root)
            preview = proposals.preview({"group_id": group_id, "model_selection": self.selection()})[0]
            proposals.authorize({
                "revision": 1, "allowed": True, "stage": "proposals", "scope": "single", "group_ids": [group_id],
                "input_signature": preview["input_signature"], "model_selection": self.selection(),
            })
            result = proposals.trigger("single-cannot-expand", {
                "group_id": group_id,
                "evidence_ref": {"evidence_id": "future-evidence", "revision_id": "future-revision"},
            })[0]
            self.assertFalse(result["triggered"])
            self.assertTrue(result["pending_authorization"])
            self.assertFalse(result["charged"])
            self.assertEqual(ProposalStore(root).inspect()[0]["jobs"], [])


if __name__ == "__main__":
    unittest.main()
