from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import _support


class IndependentGitSafetyTest(unittest.TestCase):
    def test_commit_hook_failure_restores_latest_files(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); repo = root / "repo"; repo.mkdir(parents=True)
            subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
            hook = repo / ".git/hooks/pre-commit"; hook.write_text("#!/bin/sh\nexit 1\n"); hook.chmod(0o755)
            result = _support.run_cli_process(root, ["init"])
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / "config.json").exists())
            self.assertFalse((repo / "groups.json").exists())
            self.assertEqual(_support.git(repo, "status", "--porcelain"), "")

    def test_manage_and_remember_commit_hook_failures_restore_latest_state(self) -> None:
        cases = (
            (["manage-group", "--stdin"], {"action": "create", "name": "coding", "description": "代码"}),
            (["remember", "--stdin"], {"group": "global", "rule": "回答先给结论", "task_id": None}),
        )
        for args, payload in cases:
            with self.subTest(command=args[0]), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); _support.run_cli(root, ["init"]); repo = root / "repo"
                before_head = _support.git(repo, "rev-parse", "HEAD")
                before_groups = (repo / "groups.json").read_bytes()
                hook = repo / ".git/hooks/pre-commit"; hook.write_text("#!/bin/sh\nexit 1\n"); hook.chmod(0o755)
                result = _support.run_cli_process(root, args, payload)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(_support.git(repo, "rev-parse", "HEAD"), before_head)
                self.assertEqual((repo / "groups.json").read_bytes(), before_groups)
                self.assertEqual(_support.git(repo, "status", "--porcelain"), "")

    def test_rollback_commit_hook_failure_restores_latest_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _support.run_cli(root, ["init"]); repo = root / "repo"
            _support.run_cli(root, ["manage-group", "--stdin"], {"action": "add_rule", "group": "global", "rule": "回滚目标"})
            before_head = _support.git(repo, "rev-parse", "HEAD")
            before_groups = (repo / "groups.json").read_bytes()
            preview = _support.run_cli(root, ["rollback", "--preview"])
            hook = repo / ".git/hooks/pre-commit"; hook.write_text("#!/bin/sh\nexit 1\n"); hook.chmod(0o755)
            result = _support.run_cli_process(root, ["rollback", "--stdin"], {"expected_operation_id": preview["target_operation_id"], "expected_head": preview["expected_head"]})
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(_support.git(repo, "rev-parse", "HEAD"), before_head)
            self.assertEqual((repo / "groups.json").read_bytes(), before_groups)
            self.assertEqual(_support.git(repo, "status", "--porcelain"), "")

    def test_index_lock_and_preexisting_staged_file_are_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _support.run_cli(root, ["init"]); repo = root / "repo"
            before = (repo / "groups.json").read_bytes()
            lock = repo / ".git/index.lock"; lock.write_text("lock")
            failed = _support.run_cli_process(root, ["manage-group", "--stdin"], {"action": "create", "name": "coding", "description": "代码"})
            self.assertNotEqual(failed.returncode, 0); lock.unlink(); self.assertEqual((repo / "groups.json").read_bytes(), before)
            note = repo / "notes.txt"; note.write_text("staged"); _support.git(repo, "add", "notes.txt")
            failed = _support.run_cli_process(root, ["manage-group", "--stdin"], {"action": "create", "name": "docs", "description": "文档"})
            self.assertNotEqual(failed.returncode, 0)
            self.assertEqual(_support.git(repo, "diff", "--cached", "--name-only"), "notes.txt")

    def test_push_failure_keeps_local_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _support.run_cli(root, ["init"])
            config_path = root / "config.json"; config = json.loads(config_path.read_text()); config["git_auto_push"] = True; config_path.write_text(json.dumps(config))
            repo = root / "repo"; _support.git(repo, "remote", "add", "origin", str(root / "missing.git")); before = _support.git(repo, "rev-parse", "HEAD")
            result = _support.run_cli(root, ["manage-group", "--stdin"], {"action": "create", "name": "coding", "description": "代码"})
            self.assertNotEqual(result["commit"], before); self.assertFalse(result["pushed"]); self.assertEqual(result["sync_state"], "ahead")


if __name__ == "__main__":
    unittest.main()
