from __future__ import annotations

import fcntl
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import _support
from wikiskill_preference_core.store import PreferenceStore


class FeedbackCliCasTest(unittest.TestCase):
    def test_partial_stdin_never_holds_the_data_root_lock_or_blocks_a_complete_query(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            PreferenceStore.init(root)
            blocker = subprocess.Popen(
                [sys.executable, str(_support.CLI), "evidence", "--stdin", "--data-root", str(root)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            assert blocker.stdin is not None
            blocker.stdin.write('{"schema_version":2')
            blocker.stdin.flush()

            lock_path = root / "local" / "data.lock"
            held_before_eof = False
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline:
                descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
                try:
                    try:
                        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        fcntl.flock(descriptor, fcntl.LOCK_UN)
                    except BlockingIOError:
                        held_before_eof = True
                        break
                finally:
                    os.close(descriptor)
                time.sleep(0.025)

            query = _support.request("complete-query", "list", payload={})
            probe = subprocess.Popen(
                [sys.executable, str(_support.CLI), "evidence", "--stdin", "--data-root", str(root)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            query_blocked = False
            try:
                probe_stdout, probe_stderr = probe.communicate(json.dumps(query), timeout=1.0)
            except subprocess.TimeoutExpired:
                query_blocked = True
                probe_stdout = probe_stderr = ""
            finally:
                blocker.stdin.close()
                blocker.wait(timeout=5)
                if query_blocked:
                    probe_stdout, probe_stderr = probe.communicate(timeout=5)
                if blocker.stdout is not None:
                    blocker.stdout.close()
                if blocker.stderr is not None:
                    blocker.stderr.close()

            self.assertFalse(held_before_eof, "CLI acquired the data-root lock before stdin EOF")
            self.assertFalse(query_blocked, "complete evidence query waited on a partial-stdin caller")
            self.assertEqual(probe.returncode, 0, probe_stdout or probe_stderr)
            self.assertTrue(json.loads(probe_stdout)["ok"])

    def test_oversized_stdin_fails_bounded_and_leaves_the_root_queryable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            PreferenceStore.init(root)
            oversized = '{"request_id":"oversized","padding":"' + ("x" * (4 * 1024 * 1024)) + '"}'
            result = subprocess.run(
                [sys.executable, str(_support.CLI), "evidence", "--stdin", "--data-root", str(root)],
                input=oversized,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 2)
            envelope = json.loads(result.stdout)
            self.assertEqual(envelope["error"]["code"], "preference_error")
            self.assertIn("stdin exceeded 4 MiB", envelope["error"]["message"])
            listed = _support.run_cli(root, ["evidence", "--stdin"], _support.request("after-oversized", "list", payload={}))
            self.assertTrue(listed["ok"])

    def test_concurrent_update_has_one_cas_winner_and_one_stale_writer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); PreferenceStore.init(root)
            config_path = root / "config.json"; config = json.loads(config_path.read_text()); config["provider"] = {"name": "fake", "model": "fixture", "api_key_env": "PREFERENCE_TEST_KEY", "thinking_level": "off", "max_tokens": 128, "timeout_seconds": 10}; config["learning"]["extraction"]["enabled"] = True; config_path.write_text(json.dumps(config))
            group_id = PreferenceStore(root).read_groups_v2()[0].id
            selection = {"provider_source": "fake", "provider_id": "fake", "model_id": "fixture", "api_type": "fake", "endpoint_fingerprint": f"sha256:{hashlib.sha256(b'').hexdigest()}", "thinking_level": "off", "max_tokens": 128, "timeout_seconds": 10, "config_version": 2}
            snapshot = {"session_id": "s", "task_key": "t", "user_entry_id": "u", "assistant_entry_id": "a", "user_text": "请求", "assistant_text": "结果", "origin_verified": True, "storage_mode": "ask"}
            preview = _support.run_cli(root, ["feedback", "--stdin"], _support.request("preview", "preview", payload={"feedback": "fix: 修改", "snapshot": snapshot, "model_selection": selection}))
            authorize = _support.run_cli(root, ["feedback", "--stdin"], _support.request("auth", "authorize", expected_generation=preview["cas"]["generation"], payload={"revision": 1, "allowed": True, "scope": "single", "input_signature": preview["data"]["input_signature"], "model_selection": selection}))
            created = _support.run_cli(root, ["feedback", "--stdin"], _support.request("create", "create", expected_generation=authorize["cas"]["generation"], payload={"feedback": "fix: 修改", "group_id": group_id, "snapshot": snapshot, "model_selection": selection, "consent_revision": 1}))
            job = created["data"]["job"]
            listed = _support.run_cli(root, ["feedback", "--stdin"], _support.request("list", "list", payload={}))
            payload = {"job_id": job["job_id"], "generation": job["generation"], "feedback": "fix: 新反馈"}
            requests = [_support.request(f"update-{index}", "update", expected_generation=listed["cas"]["generation"], payload=payload) for index in (1, 2)]
            processes = [subprocess.Popen([sys.executable, str(_support.CLI), "feedback", "--stdin", "--data-root", str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in requests]
            for process, request in zip(processes, requests):
                assert process.stdin is not None
                process.stdin.write(json.dumps(request)); process.stdin.close()
            results = []
            for process in processes:
                process.wait(timeout=10)
                assert process.stdout is not None and process.stderr is not None
                results.append((process.stdout.read(), process.stderr.read()))
                process.stdout.close(); process.stderr.close()
            codes = [process.returncode for process in processes]
            self.assertEqual(sorted(codes), [0, 2])
            self.assertEqual(sum(1 for stdout, _stderr in results if json.loads(stdout).get("ok") is True), 1)


if __name__ == "__main__":
    unittest.main()
