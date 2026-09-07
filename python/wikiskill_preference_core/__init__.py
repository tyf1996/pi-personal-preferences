"""Minimal personal-preference storage contracts."""

from .errors import (
    PreferenceConflictError,
    PreferenceError,
    PreferenceGitError,
    PreferenceIntegrityError,
    PreferenceValidationError,
)
from .storage import PreferenceStore

__all__ = [
    "PreferenceConflictError",
    "PreferenceError",
    "PreferenceGitError",
    "PreferenceIntegrityError",
    "PreferenceStore",
    "PreferenceValidationError",
]
