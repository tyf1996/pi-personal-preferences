from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import _support
from wikiskill_preference_core.store import PreferenceStore


class LatestLifecycleTest(unittest.TestCase):
    def test_init_is_idempotent_and_does_not_create_migration_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = PreferenceStore.init(root)
            device = (root / "device.json").read_text()
            PreferenceStore.init(root)
            self.assertEqual(device, (root / "device.json").read_text())
            self.assertFalse((root / "local/migrations").exists())
            self.assertEqual(first.config.schema_version, 2)

    def test_status_and_groups_are_read_only_latest_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _support.run_cli(root, ["init"])
            before = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
            status = _support.run_cli(root, ["status"])
            groups = _support.run_cli(root, ["groups"])
            self.assertIn("pending_feedback_count", status)
            self.assertEqual(groups["groups"][0]["id"], json.loads((root / "repo/groups.json").read_text())["groups"][0]["id"])
            after = {path: path.read_bytes() for path in root.rglob("*") if path.is_file()}
            self.assertEqual(before, after)

    def test_cli_rejects_v1_config_without_migration_ui(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            _support.run_cli(root, ["init"])
            config_path = root / "config.json"
            config = json.loads(config_path.read_text())
            config["schema_version"] = 1
            config_path.write_text(json.dumps(config))
            result = _support.run_cli_process(root, ["status"])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("schema_version", result.stderr)


if __name__ == "__main__":
    unittest.main()
