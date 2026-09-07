"""Minimal Git versioning for formal group/rule data."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Callable

from .errors import PreferenceGitError
from .storage import redact_sensitive

GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_AUTHOR_NAME": "Pi Personal Preferences",
    "GIT_AUTHOR_EMAIL": "pi-personal-preferences@localhost",
    "GIT_COMMITTER_NAME": "Pi Personal Preferences",
    "GIT_COMMITTER_EMAIL": "pi-personal-preferences@localhost",
}


def _run(repo: Path, args: list[str], *, check: bool = True, timeout: float = 30) -> subprocess.CompletedProcess[str]:
    environment = {key: value for key, value in os.environ.items() if isinstance(value, str)}
    environment.update(GIT_ENV)
    try:
        result = subprocess.run(
            ["git", *args], cwd=repo, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, check=False, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PreferenceGitError(f"cannot run Git: {exc}") from exc
    if check and result.returncode != 0:
        message = redact_sensitive(result.stderr.strip() or result.stdout.strip())[:1000]
        raise PreferenceGitError(f"git {' '.join(args)} failed: {message}")
    return result


def ensure_repository(repo: str | Path) -> Path:
    raw = Path(repo)
    if raw.is_symlink():
        raise PreferenceGitError("preference repository cannot be a symlink")
    path = raw.resolve()
    path.mkdir(parents=True, exist_ok=True)
    git_dir = path / ".git"
    if git_dir.is_symlink():
        raise PreferenceGitError("preference .git cannot be a symlink")
    if not git_dir.exists():
        _run(path, ["init", "--quiet"])
    if not git_dir.exists():
        raise PreferenceGitError("preference repository was not initialized")
    if not _run(path, ["config", "--local", "user.name"], check=False).stdout.strip():
        _run(path, ["config", "--local", "user.name", GIT_ENV["GIT_AUTHOR_NAME"]])
    if not _run(path, ["config", "--local", "user.email"], check=False).stdout.strip():
        _run(path, ["config", "--local", "user.email", GIT_ENV["GIT_AUTHOR_EMAIL"]])
    return path


def head(repo: str | Path) -> str | None:
    path = ensure_repository(repo)
    result = _run(path, ["rev-parse", "HEAD"], check=False)
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def require_clean(repo: str | Path) -> Path:
    path = ensure_repository(repo)
    if _run(path, ["status", "--porcelain", "--", "groups.json"], check=False).stdout.strip():
        raise PreferenceGitError("preference groups have uncommitted changes")
    if _run(path, ["diff", "--cached", "--quiet"], check=False).returncode != 0:
        raise PreferenceGitError("preference repository has pre-existing staged changes")
    lock = _run(path, ["rev-parse", "--git-path", "index.lock"]).stdout.strip()
    lock_path = Path(lock) if Path(lock).is_absolute() else path / lock
    if lock_path.exists() or lock_path.is_symlink():
        raise PreferenceGitError("preference Git index is locked")
    return path


def commit_groups(repo: str | Path, message: str) -> str | None:
    path = ensure_repository(repo)
    _run(path, ["add", "--", "groups.json"])
    if _run(path, ["diff", "--cached", "--quiet"], check=False).returncode == 0:
        return None
    _run(path, ["commit", "--quiet", "-m", message])
    return head(path)


def restore_failed_group_write(repo: str | Path, previous: bytes | None) -> None:
    path = ensure_repository(repo)
    groups = path / "groups.json"
    if previous is None:
        groups.unlink(missing_ok=True)
    else:
        temporary = groups.with_name(f".{groups.name}.restore")
        temporary.write_bytes(previous)
        os.replace(temporary, groups)
    _run(path, ["reset", "--quiet", "--", "groups.json"], check=False)


def has_remote(repo: str | Path) -> bool:
    return bool(_run(ensure_repository(repo), ["remote"], check=False).stdout.strip())


def has_upstream(repo: str | Path) -> bool:
    return _run(ensure_repository(repo), ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], check=False).returncode == 0


def sync_state(repo: str | Path) -> str:
    try:
        path = ensure_repository(repo)
        if not has_remote(path):
            return "no-remote"
        if _run(path, ["status", "--porcelain"], check=False).stdout.strip():
            return "error"
        if not has_upstream(path):
            return "ahead" if head(path) else "clean"
        result = _run(path, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], check=False)
        behind, ahead = (int(item) for item in result.stdout.split())
        if behind and ahead:
            return "diverged"
        if behind:
            return "behind"
        if ahead:
            return "ahead"
        return "clean"
    except (PreferenceGitError, ValueError):
        return "error"


def assert_sync_scope(repo: str | Path) -> None:
    """Allow manual sync only when outgoing history contains formal groups.json changes."""

    path = ensure_repository(repo)
    if _run(path, ["status", "--porcelain"], check=False).stdout.strip():
        raise PreferenceGitError("preference repository must be clean before sync")
    if has_upstream(path):
        changed = _run(path, ["diff", "--name-only", "@{u}..HEAD"], check=False).stdout.splitlines()
    else:
        changed = _run(path, ["ls-files"], check=False).stdout.splitlines()
    disallowed = [name for name in changed if name != "groups.json"]
    if disallowed:
        raise PreferenceGitError("sync stopped because outgoing history contains legacy non-rule files; no private feedback or evidence was uploaded")


def fetch_remote(repo: str | Path) -> str | None:
    """Fetch without holding the preference data lock; return the fetched upstream OID."""

    path = ensure_repository(repo)
    if not has_remote(path) or not has_upstream(path):
        return None
    remote = _run(path, ["config", "--get", "branch." + _run(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.strip() + ".remote"]).stdout.strip()
    if not remote:
        raise PreferenceGitError("preference upstream remote is unavailable")
    _run(path, ["fetch", "--no-tags", remote], timeout=120)
    result = _run(path, ["rev-parse", "@{u}"])
    oid = result.stdout.strip()
    if not oid:
        raise PreferenceGitError("preference upstream did not resolve after fetch")
    tracked = _run(path, ["ls-tree", "-r", "--name-only", oid], check=False).stdout.splitlines()
    if any(name != "groups.json" for name in tracked):
        raise PreferenceGitError("sync stopped because the remote contains legacy non-rule files; no private feedback or evidence was downloaded")
    return oid


def rebase_fetched(repo: str | Path, upstream_oid: str | None, validate: Callable[[], object] | None = None) -> bool:
    """Apply an already fetched upstream while group/rule writes are serialized."""

    path = require_clean(repo)
    if upstream_oid is None:
        if validate is not None:
            validate()
        return False
    before = head(path)
    try:
        _run(path, ["rebase", upstream_oid], timeout=120)
        if validate is not None:
            validate()
    except Exception:
        _run(path, ["rebase", "--abort"], check=False, timeout=120)
        if before and head(path) != before:
            _run(path, ["reset", "--hard", before], timeout=120)
        raise
    return before != head(path)


def push_remote(repo: str | Path) -> bool:
    """Push without holding the preference data lock."""

    path = ensure_repository(repo)
    if not has_remote(path):
        return False
    if has_upstream(path):
        _run(path, ["push"], timeout=120)
        return True
    branch = _run(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], check=False).stdout.strip()
    if not branch:
        raise PreferenceGitError("cannot push a detached preference repository")
    remotes = _run(path, ["remote"], check=False).stdout.splitlines()
    remote = "origin" if "origin" in remotes else remotes[0]
    _run(path, ["push", "--set-upstream", remote, branch], timeout=120)
    return True
