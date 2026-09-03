"""Strict local configuration for personal preference groups."""

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

from .contracts import SCHEMA_VERSION, stable_json_dumps
from .errors import PreferenceConfigError

CONFIG_KEYS = {
    "schema_version",
    "enabled",
    "repo_path",
    "capture_user_edits",
    "store_raw_diffs",
    "auto_evolve",
    "auto_evolve_after",
    "git_auto_push",
    "provider",
}
PROVIDER_KEYS = {
    "name", "model", "api_key_env", "base_url", "temperature", "max_tokens", "timeout_seconds",
    "thinking_level",
}
THINKING_LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}
PI_THINKING_LEVELS = {"inherit", *THINKING_LEVELS}
DEFAULT_PI_TIMEOUT_SECONDS = 300.0
ENV_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")
LEGACY_DEFAULT_PROVIDER = {
    "name": "openai_compatible",
    "model": "configured-model",
    "api_key_env": "PREFERENCE_MODEL_API_KEY",
}

DEFAULT_CONFIG: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "enabled": True,
    "repo_path": "repo",
    "capture_user_edits": True,
    "store_raw_diffs": False,
    "auto_evolve": False,
    "auto_evolve_after": 10,
    "git_auto_push": False,
    "provider": {
        "name": "pi",
        "thinking_level": "inherit",
        "timeout_seconds": DEFAULT_PI_TIMEOUT_SECONDS,
    },
}


def _atomic_write_text(path: Path, content: str) -> None:
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


def _positive_int(value: Any, label: str, *, minimum: int = 1) -> int:
    if type(value) is not int:
        raise PreferenceConfigError(f"{label} must be an integer")
    if value < minimum:
        raise PreferenceConfigError(f"{label} must be >= {minimum}")
    return value


def safe_repo_path(data_root: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise PreferenceConfigError("repo_path must be a non-empty relative path")
    path_value = Path(value)
    if (
        path_value.is_absolute()
        or re.match(r"^[A-Za-z]:[\\/]", value)
        or "\x00" in value
        or "\\" in value
    ):
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


@dataclass(frozen=True)
class PreferenceConfig:
    data_root: Path
    schema_version: int = SCHEMA_VERSION
    enabled: bool = True
    repo_path: str = "repo"
    capture_user_edits: bool = True
    store_raw_diffs: bool = False
    auto_evolve: bool = False
    auto_evolve_after: int = 10
    git_auto_push: bool = False
    provider: dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_CONFIG["provider"]))

    @classmethod
    def from_dict(cls, value: Any, data_root: str | Path) -> "PreferenceConfig":
        root = Path(data_root).resolve()
        data = _strict(value, CONFIG_KEYS, CONFIG_KEYS, "preference config")
        if type(data["schema_version"]) is not int or data["schema_version"] != SCHEMA_VERSION:
            raise PreferenceConfigError("preference config schema_version must be 1")
        raw_provider = _object(data["provider"], "provider")
        name = raw_provider.get("name")
        if not isinstance(name, str) or name not in {"pi", "fake", "openai_compatible"}:
            raise PreferenceConfigError(f"provider.name is unsupported: {name!r}")
        if name == "pi":
            provider = _strict(
                raw_provider,
                {"name", "thinking_level"},
                {"name", "thinking_level", "timeout_seconds"},
                "provider",
            )
            thinking_level = provider["thinking_level"]
            if not isinstance(thinking_level, str) or thinking_level not in PI_THINKING_LEVELS:
                raise PreferenceConfigError(f"provider.thinking_level is unsupported: {thinking_level!r}")
            timeout_value = provider.get("timeout_seconds", DEFAULT_PI_TIMEOUT_SECONDS)
            if isinstance(timeout_value, bool) or not isinstance(timeout_value, (int, float)):
                raise PreferenceConfigError("provider.timeout_seconds must be numeric")
            timeout = float(timeout_value)
            if not math.isfinite(timeout) or timeout <= 0:
                raise PreferenceConfigError("provider.timeout_seconds must be positive")
            normalized_provider = {
                "name": "pi",
                "thinking_level": thinking_level,
                "timeout_seconds": timeout,
            }
        else:
            provider = _strict(
                raw_provider,
                {"name", "model", "api_key_env", "thinking_level"},
                PROVIDER_KEYS,
                "provider",
            )
            model = provider["model"]
            if not isinstance(model, str) or not model.strip():
                raise PreferenceConfigError("provider.model must be a non-empty string")
            api_key_env = provider["api_key_env"]
            if not isinstance(api_key_env, str) or not ENV_RE.fullmatch(api_key_env):
                raise PreferenceConfigError("provider.api_key_env must be an environment variable name")
            thinking_level = provider["thinking_level"]
            if not isinstance(thinking_level, str) or thinking_level not in THINKING_LEVELS:
                raise PreferenceConfigError(f"provider.thinking_level is unsupported: {thinking_level!r}")
            base_url = provider.get("base_url")
            if base_url is not None:
                if not isinstance(base_url, str) or not base_url.startswith(("http://", "https://")):
                    raise PreferenceConfigError("provider.base_url must be an HTTP(S) URL")
                try:
                    parsed_base_url = urlsplit(base_url)
                    invalid_base_url = (
                        not parsed_base_url.netloc
                        or parsed_base_url.username is not None
                        or parsed_base_url.password is not None
                        or parsed_base_url.query
                        or parsed_base_url.fragment
                    )
                except ValueError as exc:
                    raise PreferenceConfigError("provider.base_url is malformed") from exc
                if invalid_base_url:
                    raise PreferenceConfigError("provider.base_url must not contain credentials, query, or fragment")
            normalized_provider = dict(provider)
            if "temperature" in normalized_provider:
                temperature_value = normalized_provider["temperature"]
                if isinstance(temperature_value, bool) or not isinstance(temperature_value, (int, float)):
                    raise PreferenceConfigError("provider.temperature must be numeric")
                try:
                    temperature = float(temperature_value)
                except (TypeError, ValueError) as exc:
                    raise PreferenceConfigError("provider.temperature must be numeric") from exc
                if not math.isfinite(temperature) or not 0 <= temperature <= 2:
                    raise PreferenceConfigError("provider.temperature must be within 0..2")
                normalized_provider["temperature"] = temperature
            if "max_tokens" in normalized_provider:
                normalized_provider["max_tokens"] = _positive_int(
                    normalized_provider["max_tokens"], "provider.max_tokens",
                )
            if "timeout_seconds" in normalized_provider:
                timeout_value = normalized_provider["timeout_seconds"]
                if isinstance(timeout_value, bool) or not isinstance(timeout_value, (int, float)):
                    raise PreferenceConfigError("provider.timeout_seconds must be numeric")
                try:
                    timeout = float(timeout_value)
                except (TypeError, ValueError) as exc:
                    raise PreferenceConfigError("provider.timeout_seconds must be numeric") from exc
                if not math.isfinite(timeout) or timeout <= 0:
                    raise PreferenceConfigError("provider.timeout_seconds must be positive")
                normalized_provider["timeout_seconds"] = timeout
        return cls(
            data_root=root,
            schema_version=SCHEMA_VERSION,
            enabled=_bool(data["enabled"], "enabled"),
            repo_path=str(Path(safe_repo_path(root, data["repo_path"])).relative_to(root)),
            capture_user_edits=_bool(data["capture_user_edits"], "capture_user_edits"),
            store_raw_diffs=_bool(data["store_raw_diffs"], "store_raw_diffs"),
            auto_evolve=_bool(data["auto_evolve"], "auto_evolve"),
            auto_evolve_after=_positive_int(data["auto_evolve_after"], "auto_evolve_after"),
            git_auto_push=_bool(data["git_auto_push"], "git_auto_push"),
            provider=normalized_provider,
        )

    @classmethod
    def load(cls, data_root: str | Path) -> "PreferenceConfig":
        root = Path(data_root).resolve()
        path = root / "config.json"
        if path.is_symlink():
            raise PreferenceConfigError(f"preference config cannot be a symlink: {path}")
        if path.exists() and not path.is_file():
            raise PreferenceConfigError(f"preference config must be a regular file: {path}")
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as exc:
            raise PreferenceConfigError(f"preference config does not exist: {path}") from exc
        except (OSError, json.JSONDecodeError) as exc:
            raise PreferenceConfigError(f"cannot read preference config: {path}: {exc}") from exc
        migrated = dict(raw) if isinstance(raw, dict) else raw
        changed = False
        if isinstance(migrated, dict) and "sync_evidence" in migrated:
            value = migrated.pop("sync_evidence")
            if not isinstance(value, bool):
                raise PreferenceConfigError("legacy sync_evidence must be a boolean")
            changed = True
        if isinstance(migrated, dict) and isinstance(migrated.get("provider"), dict):
            provider = dict(migrated["provider"])
            if provider == LEGACY_DEFAULT_PROVIDER:
                migrated["provider"] = dict(DEFAULT_CONFIG["provider"])
                changed = True
            elif provider.get("name") == "pi":
                original_provider = dict(provider)
                provider.setdefault("thinking_level", "inherit")
                provider.setdefault("timeout_seconds", DEFAULT_PI_TIMEOUT_SECONDS)
                if provider != original_provider:
                    migrated["provider"] = provider
                    changed = True
            elif provider.get("name") in {"fake", "openai_compatible"} and "thinking_level" not in provider:
                provider["thinking_level"] = "medium"
                migrated["provider"] = provider
                changed = True
        config = cls.from_dict(migrated, root)
        if changed:
            _atomic_write_text(path, stable_json_dumps(config.to_dict()) + "\n")
        return config

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "enabled": self.enabled,
            "repo_path": self.repo_path,
            "capture_user_edits": self.capture_user_edits,
            "store_raw_diffs": self.store_raw_diffs,
            "auto_evolve": self.auto_evolve,
            "auto_evolve_after": self.auto_evolve_after,
            "git_auto_push": self.git_auto_push,
            "provider": dict(self.provider),
        }

    def effective_thinking_level(self, environment: Mapping[str, str] | None = None) -> str:
        values = os.environ if environment is None else environment
        configured = str(self.provider["thinking_level"])
        if self.provider["name"] == "pi" and configured == "inherit":
            inherited = values.get("PI_PREFERENCE_PI_THINKING", "off")
            return inherited if inherited in THINKING_LEVELS else "off"
        return configured

    def model_identity(self, environment: Mapping[str, str] | None = None) -> str:
        values = os.environ if environment is None else environment
        if self.provider["name"] == "pi":
            provider = values.get("PI_PREFERENCE_PI_PROVIDER")
            model = values.get("PI_PREFERENCE_PI_MODEL")
            return f"{provider}/{model}" if provider and model else "pi/current"
        return f"{self.provider['name']}/{self.provider['model']}"

    def model_readiness(self, environment: Mapping[str, str] | None = None) -> tuple[bool, str]:
        """Return whether automatic classification and evolution can call the configured model."""

        values = os.environ if environment is None else environment
        if self.provider["name"] == "pi":
            if not values.get("PI_PREFERENCE_PI_PROVIDER") or not values.get("PI_PREFERENCE_PI_MODEL"):
                return False, "Pi model context is unavailable; run through the Pi extension"
            if values.get("PI_PREFERENCE_PI_AUTH_READY") != "1":
                return False, "the active Pi model has no configured authentication"
            return True, "ready"
        if self.provider["name"] == "fake":
            return True, "ready"
        base_url = self.provider.get("base_url") or values.get("OPENAI_BASE_URL")
        if not isinstance(base_url, str) or not base_url.strip():
            return False, "provider.base_url or OPENAI_BASE_URL is missing"
        try:
            parsed = urlsplit(base_url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.netloc
                or parsed.username is not None
                or parsed.password is not None
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError
        except ValueError:
            return False, "provider base URL is invalid"
        api_key_env = str(self.provider["api_key_env"])
        if not values.get(api_key_env):
            return False, f"provider credential environment variable is missing: {api_key_env}"
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
    path = root / "config.json"
    _atomic_write_text(path, stable_json_dumps(config.to_dict()) + "\n")
    return config
