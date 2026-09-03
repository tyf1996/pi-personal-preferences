"""Errors raised by the independent personal-preference mode."""

from __future__ import annotations


class PreferenceError(Exception):
    """Base class for all user-facing preference errors."""


class PreferenceConfigError(PreferenceError):
    """The local configuration is missing or invalid."""


class PreferenceContractError(PreferenceError):
    """An input or persisted contract is invalid."""


class PreferenceStorageError(PreferenceError):
    """A local file could not be read or written safely."""


class PreferenceIntegrityError(PreferenceError):
    """Persisted preference data failed an integrity or privacy check."""


class PreferenceEvolutionError(PreferenceError):
    """The model response or deterministic evolution step failed."""


class PreferenceGitError(PreferenceError):
    """A Git synchronization or rollback operation failed."""
