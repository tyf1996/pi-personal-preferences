"""Errors raised by the independent personal-preference mode."""

from __future__ import annotations


class PreferenceError(Exception):
    """Base class for all user-facing preference errors."""

    default_code = "preference_error"

    def __init__(self, message: str, *, code: str | None = None, retryable: bool = False):
        super().__init__(message)
        self.code = code or self.default_code
        self.retryable = retryable


class PreferenceConfigError(PreferenceError):
    """The local configuration is missing or invalid."""

    default_code = "invalid_config"


class PreferenceContractError(PreferenceError):
    """An input or persisted contract is invalid."""

    default_code = "invalid_contract"


class PreferenceStorageError(PreferenceError):
    """A local file could not be read or written safely."""

    default_code = "storage_error"


class PreferenceIntegrityError(PreferenceError):
    """Persisted preference data failed an integrity or privacy check."""

    default_code = "integrity_error"


class PreferenceEvolutionError(PreferenceError):
    """The model response or deterministic evolution step failed."""

    default_code = "evolution_error"


class PreferenceGitError(PreferenceError):
    """A Git synchronization or rollback operation failed."""

    default_code = "git_error"


class PreferenceConflictError(PreferenceError):
    """A compare-and-set precondition no longer matches."""

    default_code = "stale_generation"


class PreferenceRecoveryError(PreferenceError):
    """A persisted transaction cannot be recovered without user action."""

    default_code = "needs_recovery"
