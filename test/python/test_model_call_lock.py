from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import _support  # noqa: F401
from wikiskill_preference_core.jobs import FeedbackJobs
from wikiskill_preference_core.store import PreferenceStore


class DelayedHandler(BaseHTTPRequestHandler):
    started = threading.Event()
    delay = 0.8

    def do_POST(self) -> None:  # noqa: N802
        self.started.set()
        time.sleep(self.delay)
        body = json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: object) -> None:
        return


class ModelCallLockTest(unittest.TestCase):
    def test_custom_model_call_does_not_hold_data_root_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            PreferenceStore.init(root)
            config_path = root / "config.json"
            config = json.loads(config_path.read_text())
            server = ThreadingHTTPServer(("127.0.0.1", 0), DelayedHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                base_url = f"http://127.0.0.1:{server.server_port}/v1"
                config["provider"] = {"name": "openai_compatible", "model": "fixture", "api_key_env": "PREFERENCE_TEST_KEY", "base_url": base_url, "thinking_level": "off", "timeout_seconds": 5, "max_tokens": 128}
                config["learning"]["extraction"]["enabled"] = True
                config_path.write_text(json.dumps(config))
                selection = {"provider_source": "custom", "provider_id": "openai_compatible", "model_id": "fixture", "api_type": "openai_compatible", "endpoint_fingerprint": f"sha256:{hashlib.sha256(base_url.encode()).hexdigest()}", "thinking_level": "off", "max_tokens": 128, "timeout_seconds": 5, "config_version": 2}
                jobs = FeedbackJobs(root)
                snapshot = {"session_id": "session", "task_key": "task", "user_entry_id": "user", "assistant_entry_id": "assistant", "user_text": "请简洁回答", "assistant_text": "这是较长回答", "origin_verified": True, "storage_mode": "ask"}
                preview = jobs.preview({"feedback": "fix: 请简洁", "snapshot": snapshot, "model_selection": selection})[0]
                jobs.authorize({"revision": 1, "allowed": True, "scope": "single", "input_signature": preview["input_signature"], "model_selection": selection})
                group_id = PreferenceStore(root).read_groups_v2()[0].id
                created, _ = jobs.create("model-delay-job", {"feedback": "fix: 请简洁", "group_id": group_id, "snapshot": snapshot, "model_selection": selection, "consent_revision": 1})
                with patch.dict(os.environ, {"PREFERENCE_TEST_KEY": "fixture-key"}):
                    claimed, _ = jobs.claim({"job_id": created["job"]["job_id"], "owner_id": "worker", "consent_revision": 1, "model_selection": selection, "lease_seconds": 30})
                authorization = {"job_id": created["job"]["job_id"], "token": claimed["job"]["lease"]["token"], "model_selection": selection, "consent_revision": 1, "endpoint_fingerprint": selection["endpoint_fingerprint"]}
                request = {"schema_version": 2, "request_id": "model-delay", "action": "complete", "expected_generation": None, "payload": {"prompt": claimed["prompt"], "model_selection": selection, "authorization": authorization}}
                env = {**os.environ, "PREFERENCE_TEST_KEY": "fixture-key", "PYTHONPATH": str(Path(_support.CLI).parent)}
                process = subprocess.Popen([sys.executable, str(_support.CLI), "model-call", "--stdin", "--data-root", str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
                assert process.stdin is not None
                process.stdin.write(json.dumps(request)); process.stdin.close()
                self.assertTrue(DelayedHandler.started.wait(2))
                started = time.monotonic()
                subprocess.run([sys.executable, str(_support.CLI), "manage-group", "--stdin", "--data-root", str(root)], input=json.dumps({"action": "create", "name": "coding", "description": "代码"}), text=True, check=True, stdout=subprocess.PIPE)
                self.assertLess(time.monotonic() - started, DelayedHandler.delay)
                process.wait(timeout=5)
                if process.stdout is not None:
                    process.stdout.close()
            finally:
                server.shutdown(); thread.join(timeout=2); server.server_close(); DelayedHandler.started.clear()


if __name__ == "__main__":
    unittest.main()
