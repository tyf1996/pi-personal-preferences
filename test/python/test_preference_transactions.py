from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from _support import CLI, git, run_cli
from wikiskill_preference_core.contracts import stable_json_dumps
from wikiskill_preference_core.errors import (
    PreferenceConflictError,
    PreferenceIntegrityError,
    PreferenceRecoveryError,
)
from wikiskill_preference_core.git_sync import (
    begin_generated_transaction,
    commit_generated,
    complete_generated_transaction,
    restore_generated_transaction,
)
from wikiskill_preference_core.store import PreferenceStore, atomic_write_text
from wikiskill_preference_core.transactions import (
    DataRootLock,
    PersistentTransaction,
    build_git_sync_basis,
    compare_and_swap_json,
    data_root_lock,
    recover_transactions,
)


def latest_evidence_revision(group_id: str, evidence_id: str, revision_id: str, marker: str) -> dict[str, object]:
    return {
        "schema_version": 1,
        "evidence_id": evidence_id,
        "revision_id": revision_id,
        "parents": [],
        "operation": "upsert",
        "recorded_at": "2026-01-01T00:00:00+00:00",
        "author_kind": "extractor",
        "origin_task_key": f"task-{marker}",
        "origin_verified": True,
        "feedback_id": f"feedback-{marker}",
        "group_id": group_id,
        "content": {
            "raw_feedback": marker,
            "feedback_created_at": "2026-01-01T00:00:00+00:00",
            "task_summary": marker,
            "evidence_summary": marker,
            "feedback_target": {"type": "assistant_text", "description": marker, "quote": None},
            "observations": [marker],
            "actual_behavior": marker,
            "expected_behavior": marker,
            "applicability": marker,
            "nature": "preference",
            "specificity": "specific",
            "confidence": 0.9,
            "needs_review": False,
            "context_completeness": "complete",
            "sanitizer_version": "preference-sanitizer-v1",
            "extractor_prompt_version": "personal-preference-feedback-extractor-v2",
        },
    }


class PreferenceTransactionTest(unittest.TestCase):
    def test_two_processes_serialize_complete_group_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            run_cli(root, ["init"])
            processes = []
            for name in ("coding", "documentation"):
                processes.append(subprocess.Popen(
                    [sys.executable, str(CLI), "manage-group", "--stdin", "--data-root", str(root)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                ))
                assert processes[-1].stdin is not None
                processes[-1].stdin.write(json.dumps({
                    "action": "create", "name": name, "description": f"{name} group",
                }))
                processes[-1].stdin.close()
            outputs = []
            for process in processes:
                assert process.stdout is not None and process.stderr is not None
                code = process.wait(timeout=30)
                stdout = process.stdout.read()
                stderr = process.stderr.read()
                process.stdout.close()
                process.stderr.close()
                outputs.append((code, stdout, stderr))
            self.assertTrue(all(code == 0 for code, _stdout, _stderr in outputs), outputs)
            groups = json.loads((root / "repo/groups.json").read_text(encoding="utf-8"))
            self.assertEqual({item["name"] for item in groups["groups"]}, {"global", "coding", "documentation"})
            self.assertEqual(git(root / "repo", "status", "--porcelain"), "")

    def test_lock_open_failure_releases_process_mutex_for_next_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            root.mkdir()
            real_fchmod = os.fchmod
            calls = 0

            def fail_once(descriptor: int, mode: int) -> None:
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("injected fchmod failure")
                real_fchmod(descriptor, mode)

            with patch("wikiskill_preference_core.transactions.os.fchmod", side_effect=fail_once):
                with self.assertRaises(OSError):
                    with DataRootLock(root, timeout=0.1):
                        pass
                started = time.monotonic()
                with DataRootLock(root, timeout=0.5):
                    pass
                self.assertLess(time.monotonic() - started, 0.5)

    def test_transaction_id_and_parent_symlink_are_rejected_without_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            (root / "local").mkdir(parents=True)
            with self.assertRaises(PreferenceIntegrityError):
                PersistentTransaction.begin_local(
                    root,
                    {root / "local/state.json": b"{}\n"},
                    transaction_id="../escape",
                )
            self.assertFalse((root / "escape").exists())

            transaction = PersistentTransaction.begin_local(
                root,
                {root / "local/nested/state.json": b'{"generation":1}\n'},
            )
            outside = Path(temporary) / "outside"
            outside.mkdir()
            (root / "local/nested").symlink_to(outside, target_is_directory=True)
            with self.assertRaises((OSError, PreferenceIntegrityError)):
                transaction.apply()
            self.assertFalse((outside / "state.json").exists())
            with data_root_lock(root), self.assertRaises(PreferenceRecoveryError):
                recover_transactions(root)
            self.assertTrue(transaction.directory.exists())

    def test_unpublished_creating_journal_is_discarded_without_touching_data(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            transaction_root = root / "local/transactions"
            staging = transaction_root / ".txn-stage.creating-deadbeef"
            staging.mkdir(parents=True)
            (staging / "partial-blob").write_text("partial", encoding="utf-8")
            protected = root / "config.json"
            protected.write_text("protected\n", encoding="utf-8")
            with data_root_lock(root):
                result = recover_transactions(root)
            self.assertEqual(result[0]["result"], "discarded_creating")
            self.assertEqual(protected.read_text(encoding="utf-8"), "protected\n")
            self.assertFalse(staging.exists())

    def test_local_pending_transaction_rolls_back_and_cas_rejects_stale_generation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            (root / "local").mkdir(parents=True)
            target = root / "local/state.json"
            target.write_text('{"generation":0,"value":"before"}\n', encoding="utf-8")
            transaction = PersistentTransaction.begin_local(
                root,
                {target: b'{"generation":1,"value":"after"}\n'},
            )
            transaction.apply()
            self.assertIn("after", target.read_text(encoding="utf-8"))
            with data_root_lock(root):
                result = recover_transactions(root)
            self.assertEqual(result[0]["result"], "rolled_back")
            self.assertIn("before", target.read_text(encoding="utf-8"))

            cas = compare_and_swap_json(
                root,
                target,
                expected_generation=0,
                value={"generation": 1, "value": "committed"},
                resource="test-state",
            )
            self.assertEqual(cas.generation, 1)
            with self.assertRaises(PreferenceConflictError):
                compare_and_swap_json(
                    root,
                    target,
                    expected_generation=0,
                    value={"generation": 1, "value": "stale"},
                    resource="test-state",
                )

    def test_caught_exception_restore_rejects_parent_symlink_and_preserves_journal(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            store = PreferenceStore.init(root)
            nested = root / "local/nested"
            nested.mkdir()
            target = nested / "state.json"
            target.write_text("before\n", encoding="utf-8")
            with data_root_lock(root):
                transaction = begin_generated_transaction(
                    store.repo,
                    extra_paths=(target,),
                    data_root=root,
                )
                atomic_write_text(target, "after\n")
                assert transaction.journal is not None
                transaction.journal.deactivate()
                moved = root / "local/nested-original"
                nested.rename(moved)
                outside = Path(temporary) / "outside"
                outside.mkdir()
                nested.symlink_to(outside, target_is_directory=True)
                with self.assertRaises(PreferenceRecoveryError):
                    restore_generated_transaction(transaction)
                self.assertFalse((outside / "state.json").exists())
                self.assertTrue(transaction.journal.directory.exists())

    def test_git_recovery_requires_persisted_oid_marker_tree_and_current_after_image(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            store = PreferenceStore.init(root)
            with data_root_lock(root):
                transaction = begin_generated_transaction(store.repo, data_root=root)
                store.add_group_rule("global", "规则一。")
                commit_generated(store.repo, "personal-preferences: test crash")
                assert transaction.journal is not None
                with patch.object(
                    transaction.journal,
                    "commit_git",
                    side_effect=RuntimeError("simulated process death after OID persistence"),
                ):
                    with self.assertRaises(RuntimeError):
                        complete_generated_transaction(transaction)
                transaction.journal.deactivate()
            with data_root_lock(root):
                result = recover_transactions(root)
            self.assertEqual(result[0]["result"], "committed")
            self.assertEqual(store._require_group("global").rules, ["规则一。"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            store = PreferenceStore.init(root)
            with data_root_lock(root):
                transaction = begin_generated_transaction(store.repo, data_root=root)
                store.add_group_rule("global", "规则二。")
                commit_generated(store.repo, "personal-preferences: recover missing OID")
                assert transaction.journal is not None
                transaction.journal.deactivate()
            with data_root_lock(root):
                result = recover_transactions(root)
            self.assertEqual(result[0]["result"], "committed")
            self.assertEqual(store._require_group("global").rules, ["规则二。"])

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            store = PreferenceStore.init(root)
            with data_root_lock(root):
                transaction = begin_generated_transaction(store.repo, data_root=root)
                assert transaction.journal is not None
                transaction.journal.deactivate()
                groups = json.loads(store.groups_path.read_text(encoding="utf-8"))
                groups["groups"][0]["rules"].append({"id": "rule-external", "revision": 1, "text": "外部提交。", "enabled": True})
                store.groups_path.write_text(json.dumps(groups, ensure_ascii=False) + "\n", encoding="utf-8")
                subprocess.run(["git", "-C", str(store.repo), "add", "groups.json"], check=True)
                subprocess.run(["git", "-C", str(store.repo), "commit", "-m", "user: unrelated"], check=True)
            with data_root_lock(root), self.assertRaisesRegex(PreferenceRecoveryError, "subject marker"):
                recover_transactions(root)
            self.assertTrue(transaction.journal.directory.exists())

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            store = PreferenceStore.init(root)
            with data_root_lock(root):
                transaction = begin_generated_transaction(store.repo, data_root=root)
                store.add_group_rule("global", "规则三。")
                commit_generated(store.repo, "personal-preferences: tampered current tree")
                assert transaction.journal is not None
                with patch.object(transaction.journal, "commit_git", side_effect=RuntimeError("stop")):
                    with self.assertRaises(RuntimeError):
                        complete_generated_transaction(transaction)
                transaction.journal.deactivate()
                store.groups_path.write_text("{}\n", encoding="utf-8")
            with data_root_lock(root), self.assertRaises(PreferenceRecoveryError):
                recover_transactions(root)
            self.assertTrue(transaction.journal.directory.exists())

    def test_git_sync_fast_forward_records_remote_new_evidence_as_absent_before(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            remote = base / "remote.git"
            subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)
            device_a = base / "a"
            run_cli(device_a, ["init"])
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            self.assertTrue(run_cli(device_a, ["sync"])["pushed"])
            device_b = base / "b"
            device_b.mkdir()
            subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            run_cli(device_b, ["init"])
            before_head = git(device_b / "repo", "rev-parse", "HEAD")

            group_id = PreferenceStore(device_a).read_groups_v2()[0].id
            remote_file = device_a / "repo/evidence/evidence-remote-fast-forward/revision-remote-fast-forward.json"
            remote_file.parent.mkdir(parents=True)
            remote_file.write_text(stable_json_dumps(latest_evidence_revision(
                group_id, "evidence-remote-fast-forward", "revision-remote-fast-forward", "remote-fast-forward",
            )) + "\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(device_a / "repo"), "add", "evidence/evidence-remote-fast-forward/revision-remote-fast-forward.json"], check=True)
            subprocess.run(["git", "-C", str(device_a / "repo"), "commit", "-m", "user: remote evidence"], check=True)
            run_cli(device_a, ["sync"])
            upstream_head = git(device_a / "repo", "rev-parse", "HEAD")

            synced = run_cli(device_b, ["sync"])
            self.assertTrue(synced["pulled"])
            self.assertNotEqual(before_head, synced["git_head"])
            self.assertEqual(synced["git_head"], upstream_head)
            evidence_files = sorted((device_b / "repo/evidence").rglob("*.json"))
            self.assertEqual(len(evidence_files), 1)
            self.assertIn("remote-fast-forward", evidence_files[0].read_text(encoding="utf-8"))
            self.assertEqual(list((device_b / "local/transactions").iterdir()), [])

    def test_git_sync_nonconflict_rebase_keeps_upstream_and_replayed_local_patch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            remote = base / "remote.git"
            subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)
            device_a = base / "a"
            run_cli(device_a, ["init"])
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            run_cli(device_a, ["sync"])
            device_b = base / "b"
            device_b.mkdir()
            subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            run_cli(device_b, ["init"])

            run_cli(device_b, ["manage-group", "--stdin"], {
                "action": "add_rule",
                "group": "global",
                "rule": "保留设备 B 的本地规则。",
            })
            old_b_head = git(device_b / "repo", "rev-parse", "HEAD")
            group_id = PreferenceStore(device_a).read_groups_v2()[0].id
            remote_file = device_a / "repo/evidence/evidence-remote-divergent/revision-remote-divergent.json"
            remote_file.parent.mkdir(parents=True)
            remote_file.write_text(stable_json_dumps(latest_evidence_revision(
                group_id, "evidence-remote-divergent", "revision-remote-divergent", "remote-divergent",
            )) + "\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(device_a / "repo"), "add", "evidence/evidence-remote-divergent/revision-remote-divergent.json"], check=True)
            subprocess.run(["git", "-C", str(device_a / "repo"), "commit", "-m", "user: remote divergent evidence"], check=True)
            run_cli(device_a, ["sync"])
            upstream_head = git(device_a / "repo", "rev-parse", "HEAD")

            synced = run_cli(device_b, ["sync"])
            final_head = synced["git_head"]
            self.assertTrue(synced["pulled"])
            groups = json.loads((device_b / "repo/groups.json").read_text(encoding="utf-8"))
            self.assertEqual([rule["text"] for rule in groups["groups"][0]["rules"]], ["保留设备 B 的本地规则。"])
            evidence_text = "\n".join(
                path.read_text(encoding="utf-8") for path in (device_b / "repo/evidence").rglob("*.json")
            )
            self.assertIn("remote-divergent", evidence_text)
            upstream_is_ancestor = subprocess.run(
                ["git", "-C", str(device_b / "repo"), "merge-base", "--is-ancestor", upstream_head, final_head],
                check=False,
            )
            old_b_is_ancestor = subprocess.run(
                ["git", "-C", str(device_b / "repo"), "merge-base", "--is-ancestor", old_b_head, final_head],
                check=False,
            )
            self.assertEqual(upstream_is_ancestor.returncode, 0)
            self.assertNotEqual(old_b_is_ancestor.returncode, 0)
            self.assertEqual(list((device_b / "local/transactions").iterdir()), [])

    def test_interrupted_init_and_rebase_have_repeatable_recovery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "data"
            script = "\n".join([
                "import os",
                "from pathlib import Path",
                "from unittest.mock import patch",
                "from wikiskill_preference_core.store import PreferenceStore",
                f"root = Path({str(root)!r})",
                "with patch('wikiskill_preference_core.git_sync.initialize_commit', side_effect=lambda _repo: os._exit(91)):",
                "    PreferenceStore.init(root)",
            ])
            crashed = subprocess.run(
                [sys.executable, "-c", script],
                env={**os.environ, "PYTHONPATH": str(CLI.parent)},
                check=False,
            )
            self.assertEqual(crashed.returncode, 91)
            self.assertTrue(any((root / "local/transactions").iterdir()))
            recovered = PreferenceStore.init(root)
            self.assertEqual(recovered.group_names(), ["global"])
            self.assertEqual(list((root / "local/transactions").iterdir()), [])

        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            remote = base / "remote.git"
            subprocess.run(["git", "init", "--bare", "--quiet", str(remote)], check=True)
            device_a = base / "a"
            run_cli(device_a, ["init"])
            subprocess.run(["git", "-C", str(device_a / "repo"), "remote", "add", "origin", str(remote)], check=True)
            subprocess.run(["git", "-C", str(device_a / "repo"), "push", "-u", "origin", "HEAD"], check=True)
            run_cli(device_a, ["manage-group", "--stdin"], {
                "action": "add_rule", "group": "global", "rule": "原始规则。",
            })
            subprocess.run(["git", "-C", str(device_a / "repo"), "push"], check=True)
            device_b = base / "b"
            device_b.mkdir()
            subprocess.run(["git", "clone", "--quiet", str(remote), str(device_b / "repo")], check=True)
            run_cli(device_b, ["init"])
            run_cli(device_a, ["manage-group", "--stdin"], {
                "action": "update_rule", "group": "global", "rule": "原始规则。", "replacement": "设备 A。",
            })
            subprocess.run(["git", "-C", str(device_a / "repo"), "push"], check=True)
            run_cli(device_b, ["manage-group", "--stdin"], {
                "action": "update_rule", "group": "global", "rule": "原始规则。", "replacement": "设备 B。",
            })
            before_head = git(device_b / "repo", "rev-parse", "HEAD")
            subprocess.run(["git", "-C", str(device_b / "repo"), "fetch", "--no-tags", "origin"], check=True)
            sync_basis = build_git_sync_basis(
                device_b / "repo",
                local_ref="refs/heads/master",
                upstream_ref="refs/remotes/origin/master",
                base_head=before_head,
            )
            with data_root_lock(device_b):
                transaction = begin_generated_transaction(
                    device_b / "repo",
                    data_root=device_b,
                    kind="git_sync",
                    sync_basis=sync_basis,
                )
                pull = subprocess.run(
                    ["git", "-C", str(device_b / "repo"), "rebase", sync_basis["upstream_oid"]],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(pull.returncode, 0)
                assert transaction.journal is not None
                transaction.journal.deactivate()
            with data_root_lock(device_b):
                result = recover_transactions(device_b)
            self.assertEqual(result[0]["result"], "rolled_back_rebase")
            self.assertEqual(git(device_b / "repo", "rev-parse", "HEAD"), before_head)
            self.assertFalse((device_b / "repo/.git/rebase-merge").exists())
            self.assertEqual(PreferenceStore(device_b)._require_group("global").rules, ["设备 B。"])


if __name__ == "__main__":
    unittest.main()
