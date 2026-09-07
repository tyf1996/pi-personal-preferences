from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import _support
from wikiskill_preference_core.store import PreferenceStore


class FeedbackCliCasTest(unittest.TestCase):
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
