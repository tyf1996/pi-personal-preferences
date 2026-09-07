from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parents[2]
PYTHON_ROOT = PACKAGE_ROOT / "python"
CLI = PYTHON_ROOT / "wikiskill_preference.py"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))


def run_cli_process(
    data_root: Path,
    args: list[str],
    value: dict[str, Any] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CLI), *args, "--data-root", str(data_root)],
        input=json.dumps(value, ensure_ascii=False) if value is not None else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )


def run_cli(data_root: Path, args: list[str], value: dict[str, Any] | None = None) -> dict[str, Any]:
    result = run_cli_process(data_root, args, value)
    if result.returncode != 0:
        raise AssertionError(result.stdout or result.stderr)
    return json.loads(result.stdout)


def request(
    request_id: str,
    action: str,
    *,
    expected_generation: int | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "schema_version": 2,
        "request_id": request_id,
        "action": action,
        "expected_generation": expected_generation,
        "payload": payload or {},
    }


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return result.stdout.strip()
