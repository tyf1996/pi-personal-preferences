"""Strict latest-format configuration for personal preferences."""

from __future__ import annotations

import json
import math
import os
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit

from .contracts import stable_json_dumps
from .errors import PreferenceConfigError

CONFIG_SCHEMA_VERSION = 2
CONFIG_KEYS = {
    "schema_version", "enabled", "repo_path", "capture_user_edits", "store_raw_diffs",
    "git_auto_push", "provider", "learning", "privacy",
}
LEARNING_KEYS = {"extraction", "proposals", "proposal_trigger", "apply_mode", "max_attempts", "max_requests_per_day"}
STAGE_KEYS = {"enabled", "provider", "thinking_level", "timeout_seconds", "max_tokens"}
PRIVACY_KEYS = {"context_mode", "snapshot_retention_days", "evidence_sync"}
PROVIDER_KEYS = {"name", "model", "api_key_env", "base_url", "temperature", "max_tokens", "timeout_seconds", "thinking_level"}
THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
PI_THINKING_LEVELS = {"inherit", *THINKING_LEVELS}
DEFAULT_PI_TIMEOUT_SECONDS = 300.0
ENV_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")

DEFAULT_CONFIG: dict[str, Any] = {
    "schema_version": CONFIG_SCHEMA_VERSION,
    "enabled": True,
    "repo_path": "repo",
    "capture_user_edits": True,
    "store_raw_diffs": False,
    "git_auto_push": False,
    "provider": {
        "name": "pi",
        "thinking_level": "inherit",
        "timeout_seconds": DEFAULT_PI_TIMEOUT_SECONDS,
        "max_tokens": 2048,
    },
    "learning": {
        "extraction": {
            "enabled": False,
            "provider": "inherit",
            "thinking_level": "inherit",
            "timeout_seconds": "inherit",
            "max_tokens": "inherit",
        },
        "proposals": {
            "enabled": False,
            "provider": "inherit",
            "thinking_level": "inherit",
            "timeout_seconds": "inherit",
            "max_tokens": "inherit",
        },
        "proposal_trigger": "manual",
        "apply_mode": "review",
        "max_attempts": 3,
        "max_requests_per_day": 20,
    },
    "privacy": {"context_mode": "ask", "snapshot_retention_days": 7, "evidence_sync": "explicit"},
}


def _atomic_write_text(path: Path, content: str) -> None:
    from .transactions import active_transaction_for, secure_atomic_write

    transaction = active_transaction_for(path)
    if transaction is not None:
        encoded = content.encode("utf-8")
        transaction.record_after(path, encoded)
        secure_atomic_write(transaction.data_root, path, encoded)
        return
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise PreferenceConfigError(f"preference config must be a regular file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise PreferenceConfigError(f"cannot write preference config: {path}: {exc}") from exc


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, Mapping) or isinstance(value, list):
        raise PreferenceConfigError(f"{label} must be an object")
    return dict(value)


def _strict(value: Any, required: set[str], allowed: set[str], label: str) -> dict[str, Any]:
    data = _object(value, label)
    missing = required - set(data)
    unknown = set(data) - allowed
    if missing:
        raise PreferenceConfigError(f"{label} missing keys: {sorted(missing)}")
    if unknown:
        raise PreferenceConfigError(f"{label} unknown keys: {sorted(map(str, unknown))}")
    return data


def _bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise PreferenceConfigError(f"{label} must be a boolean")
    return value


def _positive_int(value: Any, label: str, *, minimum: int = 1, maximum: int | None = None) -> int:
    if type(value) is not int or value < minimum or (maximum is not None and value > maximum):
        bound = f" within {minimum}..{maximum}" if maximum is not None else f" >= {minimum}"
        raise PreferenceConfigError(f"{label} must be an integer{bound}")
    return value


def safe_repo_path(data_root: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise PreferenceConfigError("repo_path must be a non-empty relative path")
    path_value = Path(value)
    if path_value.is_absolute() or re.match(r"^[A-Za-z]:[\\/]", value) or "\x00" in value or "\\" in value:
        raise PreferenceConfigError("repo_path must be relative to data root")
    parts = path_value.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise PreferenceConfigError("repo_path contains an unsafe path component")
    resolved_root = data_root.resolve()
    lexical = resolved_root
    for part in parts:
        lexical /= part
        if lexical.is_symlink():
            raise PreferenceConfigError("repo_path cannot traverse a symlink")
    resolved = lexical.resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise PreferenceConfigError("repo_path escapes data root")
    return resolved


def _provider(value: Any) -> dict[str, Any]:
    raw = _object(value, "provider")
    name = raw.get("name")
    if name not in {"pi", "fake", "openai_compatible"}:
        raise PreferenceConfigError(f"provider.name is unsupported: {name!r}")
    if name == "pi":
        data = _strict(raw, {"name", "thinking_level"}, PROVIDER_KEYS, "provider")
        if data["thinking_level"] not in PI_THINKING_LEVELS:
            raise PreferenceConfigError("provider.thinking_level is unsupported")
        timeout = data.get("timeout_seconds", DEFAULT_PI_TIMEOUT_SECONDS)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(float(timeout)) or not 0 < float(timeout) <= 1800:
            raise PreferenceConfigError("provider.timeout_seconds must be within 0..1800")
        max_tokens = _positive_int(data.get("max_tokens", 2048), "provider.max_tokens", maximum=1_000_000)
        return {
            "name": "pi",
            "thinking_level": data["thinking_level"],
            "timeout_seconds": float(timeout),
            "max_tokens": max_tokens,
        }
    data = _strict(raw, {"name", "model", "api_key_env", "thinking_level"}, PROVIDER_KEYS, "provider")
    if not isinstance(data["model"], str) or not data["model"].strip():
        raise PreferenceConfigError("provider.model must be a non-empty string")
    if not isinstance(data["api_key_env"], str) or not ENV_RE.fullmatch(data["api_key_env"]):
        raise PreferenceConfigError("provider.api_key_env must be an environment variable name")
    if data["thinking_level"] not in THINKING_LEVELS:
        raise PreferenceConfigError("provider.thinking_level is unsupported")
    result = dict(data)
    if "base_url" in result:
        base_url = result["base_url"]
        if not isinstance(base_url, str) or not base_url.startswith(("http://", "https://")):
            raise PreferenceConfigError("provider.base_url must be an HTTP(S) URL")
        try:
            parsed = urlsplit(base_url)
        except ValueError as exc:
            raise PreferenceConfigError("provider.base_url is malformed") from exc
        if not parsed.netloc or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
            raise PreferenceConfigError("provider.base_url must not contain credentials, query, or fragment")
    if "temperature" in result:
        value = result["temperature"]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)) or not 0 <= float(value) <= 2:
            raise PreferenceConfigError("provider.temperature must be within 0..2")
        result["temperature"] = float(value)
    result["max_tokens"] = _positive_int(result.get("max_tokens", 2048), "provider.max_tokens", maximum=1_000_000)
    timeout = result.get("timeout_seconds", 60)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(float(timeout)) or not 0 < float(timeout) <= 1800:
        raise PreferenceConfigError("provider.timeout_seconds must be within 0..1800")
    result["timeout_seconds"] = float(timeout)
    return result


def _stage(value: Any, label: str) -> dict[str, Any]:
    data = _strict(value, STAGE_KEYS, STAGE_KEYS, label)
    provider = data["provider"]
    if provider != "inherit":
        provider = _provider(provider)
    thinking = data["thinking_level"]
    if thinking not in PI_THINKING_LEVELS:
        raise PreferenceConfigError(f"{label}.thinking_level is unsupported")
    timeout = data["timeout_seconds"]
    if timeout != "inherit":
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(float(timeout)) or not 0 < float(timeout) <= 1800:
            raise PreferenceConfigError(f"{label}.timeout_seconds must be inherit or within 0..1800")
        timeout = float(timeout)
    max_tokens = data["max_tokens"]
    if max_tokens != "inherit":
        max_tokens = _positive_int(max_tokens, f"{label}.max_tokens", maximum=1_000_000)
    return {
        "enabled": _bool(data["enabled"], f"{label}.enabled"),
        "provider": provider,
        "thinking_level": thinking,
        "timeout_seconds": timeout,
        "max_tokens": max_tokens,
    }


@dataclass(frozen=True)
class PreferenceConfig:
    data_root: Path
    schema_version: int = CONFIG_SCHEMA_VERSION
    enabled: bool = True
    repo_path: str = "repo"
    capture_user_edits: bool = True
    store_raw_diffs: bool = False
    git_auto_push: bool = False
    provider: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_CONFIG["provider"]))
    learning: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_CONFIG["learning"]))
    privacy: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_CONFIG["privacy"]))

    @classmethod
    def from_dict(cls, value: Any, data_root: str | Path) -> "PreferenceConfig":
        root = Path(data_root).resolve()
        data = _strict(value, CONFIG_KEYS, CONFIG_KEYS, "preference config")
        if type(data["schema_version"]) is not int or data["schema_version"] != CONFIG_SCHEMA_VERSION:
            raise PreferenceConfigError("preference config must use schema_version=2")
        learning = _strict(data["learning"], LEARNING_KEYS, LEARNING_KEYS, "learning")
        privacy = _strict(data["privacy"], PRIVACY_KEYS, PRIVACY_KEYS, "privacy")
        if learning["apply_mode"] != "review":
            raise PreferenceConfigError("learning.apply_mode must be review")
        if learning["proposal_trigger"] not in {"manual", "new_evidence"}:
            raise PreferenceConfigError("learning.proposal_trigger is unsupported")
        if privacy["context_mode"] not in {"ask", "local_only"} or privacy["evidence_sync"] != "explicit":
            raise PreferenceConfigError("privacy settings are invalid")
        return cls(
            data_root=root,
            schema_version=CONFIG_SCHEMA_VERSION,
            enabled=_bool(data["enabled"], "enabled"),
            repo_path=str(Path(safe_repo_path(root, data["repo_path"])).relative_to(root)),
            capture_user_edits=_bool(data["capture_user_edits"], "capture_user_edits"),
            store_raw_diffs=_bool(data["store_raw_diffs"], "store_raw_diffs"),
            git_auto_push=_bool(data["git_auto_push"], "git_auto_push"),
            provider=_provider(data["provider"]),
            learning={
                "extraction": _stage(learning["extraction"], "learning.extraction"),
                "proposals": _stage(learning["proposals"], "learning.proposals"),
                "proposal_trigger": learning["proposal_trigger"],
                "apply_mode": "review",
                "max_attempts": _positive_int(learning["max_attempts"], "learning.max_attempts", maximum=3),
                "max_requests_per_day": _positive_int(learning["max_requests_per_day"], "learning.max_requests_per_day", maximum=1000),
            },
            privacy={
                "context_mode": privacy["context_mode"],
                "snapshot_retention_days": _positive_int(privacy["snapshot_retention_days"], "privacy.snapshot_retention_days", maximum=365),
                "evidence_sync": "explicit",
            },
        )

    @classmethod
    def load(cls, data_root: str | Path) -> "PreferenceConfig":
        root = Path(data_root).resolve()
        path = root / "config.json"
        if path.is_symlink():
            raise PreferenceConfigError(f"preference config cannot be a symlink: {path}")
        if not path.exists() or not path.is_file():
            raise PreferenceConfigError(f"preference config does not exist: {path}")
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceConfigError(f"cannot read preference config: {path}: {exc}") from exc
        return cls.from_dict(raw, root)

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": CONFIG_SCHEMA_VERSION,
            "enabled": self.enabled,
            "repo_path": self.repo_path,
            "capture_user_edits": self.capture_user_edits,
            "store_raw_diffs": self.store_raw_diffs,
            "git_auto_push": self.git_auto_push,
            "provider": dict(self.provider),
            "learning": dict(self.learning),
            "privacy": dict(self.privacy),
        }

    def stage_enabled(self, stage: str) -> bool:
        if stage not in {"extraction", "proposals"}:
            raise PreferenceConfigError(f"unknown learning stage: {stage}")
        return bool(self.learning[stage]["enabled"])

    def stage_provider(self, stage: str) -> dict[str, Any]:
        if stage not in {"extraction", "proposals"}:
            raise PreferenceConfigError(f"unknown learning stage: {stage}")
        settings = self.learning[stage]
        base = self.provider if settings["provider"] == "inherit" else settings["provider"]
        result = dict(base)
        for key in ("thinking_level", "timeout_seconds", "max_tokens"):
            if settings[key] != "inherit":
                result[key] = settings[key]
        # A custom stage cannot send the Pi-only inherit sentinel. Inheriting a
        # provider value is resolved here; only an effective Pi provider may
        # retain inherit until the current Pi thinking level is frozen.
        if result["name"] != "pi" and result["thinking_level"] == "inherit":
            raise PreferenceConfigError(f"learning.{stage} resolved an invalid custom thinking level")
        return result

    def effective_thinking_level(self, environment: Mapping[str, str] | None = None, *, provider: Mapping[str, Any] | None = None) -> str:
        values = os.environ if environment is None else environment
        effective_provider = self.provider if provider is None else provider
        configured = str(effective_provider["thinking_level"])
        if effective_provider["name"] == "pi" and configured == "inherit":
            inherited = values.get("PI_PREFERENCE_PI_THINKING", "off")
            return inherited if inherited in THINKING_LEVELS else "off"
        return configured

    def model_identity(self, environment: Mapping[str, str] | None = None, *, provider: Mapping[str, Any] | None = None) -> str:
        values = os.environ if environment is None else environment
        effective_provider = self.provider if provider is None else provider
        if effective_provider["name"] == "pi":
            provider = values.get("PI_PREFERENCE_PI_PROVIDER")
            model = values.get("PI_PREFERENCE_PI_MODEL")
            return f"{provider}/{model}" if provider and model else "pi/current"
        return f"{effective_provider['name']}/{effective_provider['model']}"

    def model_readiness(self, environment: Mapping[str, str] | None = None, *, provider: Mapping[str, Any] | None = None) -> tuple[bool, str]:
        values = os.environ if environment is None else environment
        effective_provider = self.provider if provider is None else provider
        if effective_provider["name"] == "pi":
            if not values.get("PI_PREFERENCE_PI_PROVIDER") or not values.get("PI_PREFERENCE_PI_MODEL"):
                return False, "the frozen Pi model is unavailable"
            if values.get("PI_PREFERENCE_PI_AUTH_READY") != "1":
                return False, "the frozen Pi model has no configured authentication"
            return True, "ready"
        if effective_provider["name"] == "fake":
            return True, "ready"
        base_url = effective_provider.get("base_url") or values.get("OPENAI_BASE_URL")
        if not isinstance(base_url, str) or not base_url.strip():
            return False, "provider.base_url or OPENAI_BASE_URL is missing"
        if not values.get(str(effective_provider["api_key_env"])):
            return False, "provider credential is missing"
        return True, "ready"

    @property
    def repo_root(self) -> Path:
        return safe_repo_path(self.data_root, self.repo_path)

    @property
    def device_path(self) -> Path:
        return self.data_root / "device.json"

    @property
    def local_root(self) -> Path:
        return self.data_root / "local"

    @property
    def groups_path(self) -> Path:
        return self.repo_root / "groups.json"

    @property
    def activations_path(self) -> Path:
        return self.local_root / "activations.json"


def default_config(data_root: str | Path) -> PreferenceConfig:
    return PreferenceConfig.from_dict(DEFAULT_CONFIG, data_root)


def write_default_config(data_root: str | Path) -> PreferenceConfig:
    root = Path(data_root).resolve()
    config = default_config(root)
    root.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(root / "config.json", stable_json_dumps(config.to_dict()) + "\n")
    return config
