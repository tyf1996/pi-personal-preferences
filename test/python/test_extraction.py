from __future__ import annotations

import json
import unittest

import _support  # noqa: F401
from wikiskill_preference_core.extraction import extraction_prompt, parse_extraction
from wikiskill_preference_core.errors import PreferenceContractError


class ExtractionContractTest(unittest.TestCase):
    snapshot = {"session_id": "s", "task_key": "t", "user_entry_id": "u", "assistant_entry_id": "a", "user_text": "请简洁回答", "assistant_text": "这是回答结果", "origin_verified": True, "storage_mode": "ask"}
    groups = [{"id": "grp-global", "revision": 1, "name": "global", "description": "通用", "rules": [{"id": "rule-1", "revision": 1, "text": "先给结论", "enabled": True}]}]

    def test_prompt_has_visible_result_aliases_and_stable_groups(self) -> None:
        prompt = extraction_prompt(self.snapshot, self.groups, explicit_group_id="grp-global", feedback="fix: 请区分完成与完整")
        self.assertIn("assistant_result", prompt)
        self.assertIn("grp-global", prompt)
        self.assertIn("请区分完成与完整", prompt)
        self.assertIn("这是回答结果", prompt)
        self.assertNotIn("thinking", prompt)

    def test_host_validates_source_quote_group_and_actual_expected_fields(self) -> None:
        value = {"group_id": "grp-global", "target": {"type": "assistant_text", "description": "回答"}, "quote": {"source_alias": "assistant_result", "text": "这是回答结果"}, "observations": ["结果清楚"], "actual_behavior": "给出了结果", "expected_behavior": "保留结论", "task_summary": "回答请求", "evidence_summary": "偏好清晰结论", "applicability": "一般答复", "nature": "preference", "specificity": "specific", "confidence": 0.9, "needs_review": False}
        content = parse_extraction(json.dumps(value, ensure_ascii=False), self.snapshot, self.groups, explicit_group_id="grp-global")
        self.assertEqual(content["expected_behavior"], "保留结论")
        with self.assertRaises(PreferenceContractError):
            parse_extraction(json.dumps({**value, "quote": {"source_alias": "assistant_result", "text": "伪造"}}, ensure_ascii=False), self.snapshot, self.groups, explicit_group_id="grp-global")
        with self.assertRaises(PreferenceContractError):
            parse_extraction(json.dumps({**value, "group_id": "grp-other"}, ensure_ascii=False), self.snapshot, self.groups, explicit_group_id="grp-global")

    def test_generic_satisfaction_cannot_be_strong_evidence(self) -> None:
        value = {"group_id": "grp-global", "target": {"type": "assistant_text", "description": "回答"}, "quote": {"source_alias": "assistant_result", "text": "这是回答结果"}, "observations": ["满意"], "actual_behavior": "给出了结果", "expected_behavior": "保持当前表达", "task_summary": "回答请求", "evidence_summary": "满意", "applicability": "一般答复", "nature": "preference", "specificity": "specific", "confidence": 1.0, "needs_review": False}
        with self.assertRaises(PreferenceContractError):
            parse_extraction(json.dumps(value, ensure_ascii=False), self.snapshot, self.groups, feedback="good")


if __name__ == "__main__":
    unittest.main()
