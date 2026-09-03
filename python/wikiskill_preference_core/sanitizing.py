"""Local redaction and path checks for preference evidence."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Iterable

from .errors import PreferenceIntegrityError

SANITIZER_VERSION = "preference-sanitizer-v1"

_PRIVATE_KEY_RE = re.compile(
    r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ED25519 )?PRIVATE KEY-----.*?"
    r"-----END (?:RSA |EC |OPENSSH |DSA |PGP |ED25519 )?PRIVATE KEY-----",
    re.IGNORECASE | re.DOTALL,
)
_TOKEN_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("credential", re.compile(r"(?i)\bhttps?://[^/\s:@]+:[^@\s]+@")),
    ("credential", re.compile(r"(?i)\b(authorization\s*:\s*(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+")),
    ("credential", re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b")),
    ("credential", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("credential", re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b")),
    ("credential", re.compile(
        r"(?i)\b(api[_-]?key|key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\b"
        r"\s*['\"]?\s*[:=]\s*['\"]?([^\s'\"]{8,})"
    )),
    ("credential", re.compile(r"(?i)\b(cookie|set-cookie)\s*:\s*[^\r\n]+")),
)
_ABSOLUTE_PATH_PATTERNS = (
    re.compile(r"(?<![A-Za-z0-9_.:/-])/(?!/)(?:[^/\s'\"`]+/)+[^/\s'\"`]+"),
    re.compile(r"\b[A-Za-z]:/(?:[^/\s'\"`]+/)+[^/\s'\"`]+"),
    re.compile(r"\b[A-Za-z]:\\(?:[^\s'\"`\\]+\\)*[^\s'\"`\\]+"),
)
DEFAULT_DENIED_FILE_NAMES = frozenset({
    ".env", ".env.local", ".env.production", "credentials.json", "secrets.json", "id_rsa", "id_ed25519",
})


@dataclass(frozen=True)
class SanitizedText:
    text: str
    changed: bool
    privacy_labels: tuple[str, ...] = ()

    def __str__(self) -> str:
        return self.text


def sanitize_text(value: str, *, redact_paths: bool = True) -> SanitizedText:
    if not isinstance(value, str):
        raise PreferenceIntegrityError("text to sanitize must be a string")
    result = value
    labels: set[str] = set()
    if _PRIVATE_KEY_RE.search(result):
        result = _PRIVATE_KEY_RE.sub("[REDACTED_PRIVATE_KEY]", result)
        labels.add("private_key")
    for label, pattern in _TOKEN_PATTERNS:
        if pattern.search(result):
            result = pattern.sub(lambda match: f"[REDACTED_{label.upper()}]", result)
            labels.add(label)
    if redact_paths:
        for pattern in _ABSOLUTE_PATH_PATTERNS:
            if pattern.search(result):
                result = pattern.sub("[REDACTED_PATH]", result)
                labels.add("path")
    return SanitizedText(result, result != value, tuple(sorted(labels)))


def path_is_denied(path: str, denied_file_names: Iterable[str] = DEFAULT_DENIED_FILE_NAMES) -> bool:
    normalized = path.replace("\\", "/")
    name = PurePosixPath(normalized).name
    denied = {str(item) for item in denied_file_names}
    return name in denied or name.startswith(".env") or any(part in {".git", ".ssh"} for part in PurePosixPath(normalized).parts)


def safe_relative_project_path(path: str) -> str:
    if not isinstance(path, str) or not path.strip() or "\x00" in path:
        raise PreferenceIntegrityError("project path must be a non-empty string")
    normalized = path.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:/", normalized):
        raise PreferenceIntegrityError("absolute project paths are not allowed")
    parts = normalized.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise PreferenceIntegrityError("project path must be normalized and cannot contain '..'")
    return normalized


def scan_sensitive(value: str) -> tuple[str, ...]:
    result = sanitize_text(value)
    return result.privacy_labels
