"""Small Git adapter for versioning, synchronization, and revert."""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .errors import PreferenceGitError
from .sanitizing import sanitize_text

GENERATED_PATHS = ("groups.json", "evidence", "version.json")
GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_AUTHOR_NAME": "Pi Personal Preferences",
    "GIT_AUTHOR_EMAIL": "pi-personal-preferences@localhost",
    "GIT_COMMITTER_NAME": "Pi Personal Preferences",
    "GIT_COMMITTER_EMAIL": "pi-personal-preferences@localhost",
}


def _env() -> dict[str, str]:
    value = {key: item for key, item in os.environ.items() if isinstance(item, str)}
    value.update(GIT_ENV)
    return value


def _run(repo: Path, args: list[str], *, check: bool = True, timeout: float = 30) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            ["git", *args], cwd=str(repo), env=_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, check=False, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PreferenceGitError(f"cannot run git in {repo}: {exc}") from exc
    if check and result.returncode != 0:
        message = sanitize_text(result.stderr.strip() or result.stdout.strip()).text
        raise PreferenceGitError(f"git {' '.join(args)} failed: {message}")
    return result


@dataclass(frozen=True)
class GeneratedTransactionSnapshot:
    repo: Path
    head: str | None
    roots: tuple[Path, ...]
    files: dict[Path, bytes]
    index_path: Path
    index_content: bytes | None


def _atomic_write_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


def _snapshot_files(roots: Iterable[Path]) -> dict[Path, bytes]:
    files: dict[Path, bytes] = {}
    for root in roots:
        if root.is_symlink():
            raise PreferenceGitError(f"transaction path cannot be a symlink: {root}")
        if root.is_file():
            files[root] = root.read_bytes()
            continue
        if not root.exists():
            continue
        if not root.is_dir():
            raise PreferenceGitError(f"transaction path must be a file or directory: {root}")
        for path in root.rglob("*"):
            if path.is_symlink():
                raise PreferenceGitError(f"transaction path cannot contain a symlink: {path}")
            if path.is_file():
                files[path] = path.read_bytes()
    return files


def ensure_generated_transaction_ready(repo: str | Path) -> Path:
    """Reject a local mutation before it can absorb dirty files or a locked index."""

    path = ensure_repository(repo)
    dirty = _run(path, ["status", "--porcelain", "--", *GENERATED_PATHS], check=False).stdout.strip()
    if dirty:
        raise PreferenceGitError("preference repository has uncommitted generated-file changes")
    if _run(path, ["diff", "--cached", "--quiet"], check=False).returncode != 0:
        raise PreferenceGitError("preference repository has pre-existing staged changes")
    lock_value = _run(path, ["rev-parse", "--git-path", "index.lock"]).stdout.strip()
    lock_path = Path(lock_value)
    if not lock_path.is_absolute():
        lock_path = path / lock_path
    if lock_path.exists() or lock_path.is_symlink():
        raise PreferenceGitError("preference Git index is locked")
    return path


def begin_generated_transaction(
    repo: str | Path,
    *,
    extra_paths: Iterable[str | Path] = (),
) -> GeneratedTransactionSnapshot:
    """Capture generated files and the Git index before a local preference mutation."""

    path = ensure_generated_transaction_ready(repo)
    index_value = _run(path, ["rev-parse", "--git-path", "index"]).stdout.strip()
    index_path = Path(index_value)
    if not index_path.is_absolute():
        index_path = path / index_path
    if index_path.is_symlink():
        raise PreferenceGitError("preference Git index cannot be a symlink")
    roots = tuple(dict.fromkeys([
        *(path / name for name in GENERATED_PATHS),
        *(Path(item).resolve() for item in extra_paths),
    ]))
    return GeneratedTransactionSnapshot(
        repo=path,
        head=repository_head(path),
        roots=roots,
        files=_snapshot_files(roots),
        index_path=index_path,
        index_content=index_path.read_bytes() if index_path.exists() else None,
    )


def restore_generated_transaction(snapshot: GeneratedTransactionSnapshot) -> None:
    """Restore files, index, and HEAD-visible state after a failed local mutation."""

    if repository_head(snapshot.repo) != snapshot.head:
        raise PreferenceGitError("cannot restore preference transaction because Git HEAD changed")
    current = _snapshot_files(snapshot.roots)
    for path in sorted(set(current) - set(snapshot.files), key=lambda item: len(item.parts), reverse=True):
        path.unlink(missing_ok=True)
    for path, content in snapshot.files.items():
        _atomic_write_bytes(path, content)
    for root in snapshot.roots:
        if root.is_dir():
            for directory in sorted(
                (item for item in root.rglob("*") if item.is_dir()),
                key=lambda item: len(item.parts),
                reverse=True,
            ):
                try:
                    directory.rmdir()
                except OSError:
                    pass
    if snapshot.index_content is None:
        snapshot.index_path.unlink(missing_ok=True)
    else:
        _atomic_write_bytes(snapshot.index_path, snapshot.index_content)


def ensure_repository(repo: str | Path) -> Path:
    raw_path = Path(repo)
    if raw_path.is_symlink():
        raise PreferenceGitError(f"preference repository cannot be a symlink: {raw_path}")
    path = raw_path.resolve()
    path.mkdir(parents=True, exist_ok=True)
    git_dir = path / ".git"
    if git_dir.is_symlink():
        raise PreferenceGitError(f"Git directory cannot be a symlink: {git_dir}")
    if not git_dir.exists():
        _run(path, ["init", "--quiet"])
    if not git_dir.is_dir() and not git_dir.is_file():
        raise PreferenceGitError(f"invalid Git directory: {git_dir}")
    # A private preference repository must be committable on a fresh device,
    # even when the user's global Git identity is not configured.
    name = _run(path, ["config", "--local", "user.name"], check=False).stdout.strip()
    email = _run(path, ["config", "--local", "user.email"], check=False).stdout.strip()
    if not name:
        _run(path, ["config", "--local", "user.name", GIT_ENV["GIT_AUTHOR_NAME"]])
    if not email:
        _run(path, ["config", "--local", "user.email", GIT_ENV["GIT_AUTHOR_EMAIL"]])
    return path


def repository_head(repo: str | Path) -> str | None:
    path = ensure_repository(repo)
    result = _run(path, ["rev-parse", "HEAD"], check=False)
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def _stage_generated(repo: Path) -> None:
    _run(repo, ["add", "-A", "--", *GENERATED_PATHS])


def commit_generated(repo: str | Path, message: str) -> str | None:
    path = ensure_repository(repo)
    _stage_generated(path)
    if _run(path, ["diff", "--cached", "--quiet"], check=False).returncode == 0:
        return None
    _run(path, ["commit", "--quiet", "-m", message])
    head = repository_head(path)
    return head


def initialize_commit(repo: str | Path) -> str | None:
    return commit_generated(repo, "personal-preferences: initialize")


def has_remote(repo: str | Path) -> bool:
    path = ensure_repository(repo)
    return bool(_run(path, ["remote"], check=False).stdout.strip())


def has_upstream(repo: str | Path) -> bool:
    path = ensure_repository(repo)
    return _run(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], check=False).returncode == 0


def sync_state(repo: str | Path) -> str:
    """Inspect local/upstream divergence without contacting the remote."""

    try:
        path = ensure_repository(repo)
        if not has_remote(path):
            return "no-remote"
        if _run(path, ["status", "--porcelain"], check=False).stdout.strip():
            return "error"
        if not has_upstream(path):
            return "ahead" if repository_head(path) else "clean"
        result = _run(path, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], check=False)
        if result.returncode != 0:
            return "error"
        fields = result.stdout.strip().split()
        if len(fields) != 2:
            return "error"
        behind, ahead = (int(item) for item in fields)
        if behind and ahead:
            return "diverged"
        if ahead:
            return "ahead"
        if behind:
            return "behind"
        return "clean"
    except (OSError, ValueError, PreferenceGitError):
        return "error"


def pull_rebase(repo: str | Path) -> bool:
    """Pull only when a configured remote and upstream exist, aborting failed rebases."""

    path = ensure_repository(repo)
    before = repository_head(path)
    if not has_remote(path) or not has_upstream(path):
        return False
    transaction = begin_generated_transaction(path)
    try:
        _run(path, ["pull", "--rebase", "--autostash"], timeout=120)
    except PreferenceGitError:
        _run(path, ["rebase", "--abort"], check=False, timeout=120)
        if repository_head(path) != transaction.head and transaction.head:
            _run(path, ["reset", "--hard", transaction.head], timeout=120)
        restore_generated_transaction(transaction)
        raise
    return before != repository_head(path)


def push(repo: str | Path) -> bool:
    path = ensure_repository(repo)
    remotes = _run(path, ["remote"], check=False).stdout.splitlines()
    if not remotes:
        return False
    if has_upstream(path):
        _run(path, ["push"], timeout=120)
        return True
    branch = _run(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], check=False).stdout.strip()
    if not branch:
        raise PreferenceGitError("cannot initialize upstream from a detached Git HEAD")
    remote = "origin" if "origin" in remotes else remotes[0]
    _run(path, ["push", "--set-upstream", remote, branch], timeout=120)
    return True


def _commit_paths(repo: Path, commit: str) -> list[str]:
    changed = _run(repo, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit], check=False)
    return changed.stdout.splitlines() if changed.returncode == 0 else []


def _managed_path(path: str) -> bool:
    return path in {"groups.json", "version.json", "evidence"} or path.startswith("evidence/")


def _rollback_target(repo: Path, commit: str, subject: str) -> bool:
    paths = _commit_paths(repo, commit)
    return (
        subject.startswith("personal-preferences:")
        and not subject.startswith("personal-preferences: initialize")
        and not subject.startswith("personal-preferences: evidence sync")
        and "groups.json" in paths
        and bool(paths)
        and all(_managed_path(path) for path in paths)
    )


def _generated_commit(repo: Path) -> str | None:
    result = _run(repo, ["log", "--format=%H%x00%s"], check=False)
    rolled_back: set[str] = set()
    rows = [row for row in result.stdout.splitlines() if "\x00" in row]
    for row in rows:
        commit, subject = row.split("\x00", 1)
        marker = re.search(r"\[personal-preferences rollback: ([0-9a-f]{7,64})\]$", subject)
        if marker:
            rolled_back.add(marker.group(1))
            continue
        if commit in rolled_back:
            continue
        if _rollback_target(repo, commit, subject):
            return commit
    return None


def _rollback(repo: str | Path, commit: str | None = None) -> str:
    path = ensure_repository(repo)
    if _run(path, ["status", "--porcelain"], check=False).stdout.strip():
        raise PreferenceGitError("cannot rollback with a dirty preference repository")
    target = commit or _generated_commit(path)
    if not target:
        raise PreferenceGitError("no generated preference commit is available to roll back")
    verified = _run(path, ["rev-parse", "--verify", f"{target}^{{commit}}"], check=False)
    if verified.returncode != 0:
        raise PreferenceGitError(f"unknown rollback commit: {target}")
    target = verified.stdout.strip()
    subject = sanitize_text(_run(path, ["show", "-s", "--format=%s", target]).stdout.strip()).text
    if not _rollback_target(path, target, subject):
        raise PreferenceGitError("rollback target is not a generated preference group commit")
    reverted = _run(path, ["revert", "--no-commit", target], check=False, timeout=120)
    if reverted.returncode != 0:
        conflicts = _run(path, ["diff", "--name-only", "--diff-filter=U"], check=False).stdout.splitlines()
        preservable = [name for name in conflicts if name == "version.json" or name.startswith("evidence/")]
        if len(preservable) != len(conflicts):
            _run(path, ["revert", "--abort"], check=False)
            message = sanitize_text(reverted.stderr.strip() or reverted.stdout.strip()).text
            raise PreferenceGitError(f"git revert has a generated-file conflict: {message}")
        for name in preservable:
            _run(path, ["checkout", "--ours", "--", name])
            _run(path, ["add", "--", name])
        remaining = _run(path, ["diff", "--name-only", "--diff-filter=U"], check=False).stdout.splitlines()
        if remaining:
            _run(path, ["revert", "--abort"], check=False)
            raise PreferenceGitError(f"git revert has unresolved conflicts: {remaining}")
    # Evidence and its cursor are append-only history.  Restore their current
    # HEAD versions before creating the new rollback commit so later evidence
    # cannot be deleted by reverting an older generated commit.
    for name in ("evidence", "version.json"):
        _run(path, ["checkout", "HEAD", "--", name], check=False)
    _run(path, ["add", "-A", "--", *GENERATED_PATHS])
    if _run(path, ["diff", "--cached", "--quiet"], check=False).returncode == 0:
        raise PreferenceGitError("rollback produced no generated-file changes")
    message = f'Revert "{subject or target}" [personal-preferences rollback: {target}]'
    _run(path, ["commit", "--quiet", "-m", message], timeout=120)
    head = repository_head(path)
    if not head:
        raise PreferenceGitError("rollback did not produce a commit")
    return head


def rollback(repo: str | Path, commit: str | None = None) -> str:
    path = ensure_repository(repo)
    if _run(path, ["status", "--porcelain"], check=False).stdout.strip():
        raise PreferenceGitError("cannot rollback with a dirty preference repository")
    transaction = begin_generated_transaction(path)
    try:
        return _rollback(path, commit)
    except Exception:
        _run(path, ["revert", "--abort"], check=False)
        restore_generated_transaction(transaction)
        raise


def sync_repository(repo: str | Path, *, auto_push: bool = False) -> tuple[str | None, bool]:
    path = ensure_repository(repo)
    before = repository_head(path)
    changed = pull_rebase(path)
    if auto_push:
        push(path)
    return repository_head(path), changed or before != repository_head(path)
