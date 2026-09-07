"""Errors exposed by the simplified personal-preference backend."""


class PreferenceError(Exception):
    """Base error with a stable machine-readable code."""

    def __init__(self, message: str, *, code: str = "preference_error") -> None:
        super().__init__(message)
        self.code = code


class PreferenceValidationError(PreferenceError):
    def __init__(self, message: str) -> None:
        super().__init__(message, code="invalid_request")


class PreferenceIntegrityError(PreferenceError):
    def __init__(self, message: str) -> None:
        super().__init__(message, code="integrity_error")


class PreferenceConflictError(PreferenceError):
    def __init__(self, message: str) -> None:
        super().__init__(message, code="conflict")


class PreferenceGitError(PreferenceError):
    def __init__(self, message: str) -> None:
        super().__init__(message, code="git_error")
