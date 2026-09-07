from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import _support
from wikiskill_preference_core.config import PreferenceConfig
from wikiskill_preference_core.learning_contracts import CommandRequest, validate_response_envelope
from wikiskill_preference_core.store import PreferenceStore


class LatestFoundationTest(unittest.TestCase):
    def test_latest_config_rejects_old_fields_and_unknown_fields(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            PreferenceStore.init(root)
            config = json.loads((root / "config.json").read_text())
            with self.assertRaises(Exception):
                PreferenceConfig.from_dict({**config, "schema_version": 1}, root)
            with self.assertRaises(Exception):
                PreferenceConfig.from_dict({**config, "auto_evolve": True}, root)

    def test_latest_command_envelope_is_strict_and_single(self) -> None:
        request = _support.request("req", "list", payload={})
        parsed = CommandRequest.from_dict(request)
        self.assertEqual(parsed.action, "list")
        with self.assertRaises(Exception):
            CommandRequest.from_dict({**request, "legacy": True})
        response = {"schema_version": 2, "request_id": "req", "ok": True, "data": {}, "error": None, "cas": None}
        self.assertEqual(validate_response_envelope(response)["request_id"], "req")

    def test_init_and_group_mutation_are_latest_ids(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            store = PreferenceStore.init(root)
            created = store.create_group("coding", "代码任务")
            store.add_group_rule("coding", "优先复用已有设计")
            groups = json.loads((root / "repo/groups.json").read_text())["groups"]
            coding = next(item for item in groups if item["name"] == "coding")
            self.assertEqual(coding["id"], next(item for item in store.read_groups_v2() if item.name == "coding").id)
            self.assertEqual(coding["rules"][0]["enabled"], True)
            self.assertNotEqual(created.name, "global")

    def test_each_internal_command_has_an_explicit_action_allowlist(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _support.run_cli(root, ["init"])
            for command, action in (("model-call", "list"), ("model-call", "get"), ("learning-job", "list"), ("learning-job", "get"), ("feedback", "complete")):
                result = _support.run_cli_process(root, [command, "--stdin"], _support.request(f"bad-{command}-{action}", action))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout)["error"]["code"], "unsupported_action")

    def test_legacy_commands_are_not_a_production_contract(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = _support.run_cli_process(root, ["migrate", "--stdin"], _support.request("m", "plan"))
            self.assertNotEqual(result.returncode, 0)
            result = _support.run_cli_process(root, ["evolve"], None)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
