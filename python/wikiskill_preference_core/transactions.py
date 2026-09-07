"""Cross-process locking, durable short transactions, CAS, and recovery."""

from __future__ import annotations

import errno
import json
import os
import re
import stat
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from .contracts import new_id, stable_hash, stable_json_dumps, utc_now
from .errors import (
    PreferenceConflictError,
    PreferenceIntegrityError,
    PreferenceRecoveryError,
    PreferenceStorageError,
)
from .learning_contracts import CasState, cas_for

try:  # The supported implementation is intentionally explicit.
    import fcntl
except ImportError:  # pragma: no cover - exercised only on unsupported hosts.
    fcntl = None  # type: ignore[assignment]

TRANSACTION_SCHEMA_VERSION = 1
TRANSACTION_KINDS = {"local", "git", "git_sync"}
TRANSACTION_STATES = {"pending", "committed"}
_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_REF_RE = re.compile(r"^refs/(?:heads|remotes)/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$")
_LOCK_STATES: dict[Path, dict[str, Any]] = {}
_LOCK_STATES_GUARD = threading.Lock()
_ACTIVE = threading.local()


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _open_safe_parent(data_root: Path, path: Path, *, create: bool) -> tuple[int, str]:
    """Open a target parent one component at a time without following symlinks."""

    root = data_root.resolve()
    lexical = Path(os.path.abspath(path))
    try:
        relative = lexical.relative_to(root)
    except ValueError as exc:
        raise PreferenceIntegrityError(f"transaction path escapes data root: {path}") from exc
    if not relative.parts:
        raise PreferenceIntegrityError("transaction target cannot be the data root")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(root, flags)
    except OSError as exc:
        raise PreferenceIntegrityError(f"cannot safely open data root: {root}: {exc}") from exc
    try:
        for part in relative.parts[:-1]:
            try:
                child = os.open(part, flags, dir_fd=descriptor)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o700, dir_fd=descriptor)
                child = os.open(part, flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor, relative.parts[-1]
    except Exception:
        os.close(descriptor)
        raise


def _remove_tree_at(parent_fd: int, name: str) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(name, flags, dir_fd=parent_fd)
    try:
        with os.scandir(descriptor) as entries:
            for entry in entries:
                state = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(state.st_mode):
                    _remove_tree_at(descriptor, entry.name)
                elif stat.S_ISREG(state.st_mode):
                    os.unlink(entry.name, dir_fd=descriptor)
                else:
                    raise PreferenceIntegrityError(f"transaction tree contains an unsafe entry: {entry.name}")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.rmdir(name, dir_fd=parent_fd)
    os.fsync(parent_fd)


def _secure_remove_tree(data_root: Path, path: Path) -> None:
    parent_fd, name = _open_safe_parent(data_root, path, create=False)
    try:
        _remove_tree_at(parent_fd, name)
    finally:
        os.close(parent_fd)


def _target_state(parent_fd: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def _durable_write_at(data_root: Path, path: Path, content: bytes) -> None:
    parent_fd, name = _open_safe_parent(data_root, path, create=True)
    temporary_name = f".{name}.{new_id()}"
    descriptor = -1
    try:
        state = _target_state(parent_fd, name)
        if state is not None and not stat.S_ISREG(state.st_mode):
            raise PreferenceIntegrityError(f"transaction target must be a regular file: {path}")
        descriptor = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=parent_fd,
        )
        with os.fdopen(descriptor, "wb") as handle:
            descriptor = -1
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
        os.fsync(parent_fd)
    except OSError as exc:
        try:
            os.unlink(temporary_name, dir_fd=parent_fd)
        except OSError:
            pass
        raise PreferenceStorageError(f"cannot durably write {path}: {exc}") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(parent_fd)


def _durable_write(path: Path, content: bytes, *, data_root: Path | None = None) -> None:
    if data_root is not None:
        _durable_write_at(data_root, path, content)
        return
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise PreferenceIntegrityError(f"transaction target must be a regular file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise PreferenceStorageError(f"cannot durably write {path}: {exc}") from exc


def secure_atomic_write(data_root: str | Path, path: str | Path, content: bytes) -> None:
    _durable_write(Path(path), content, data_root=Path(data_root).resolve())


def secure_read_bytes(data_root: str | Path, path: str | Path) -> bytes:
    root = Path(data_root).resolve()
    target = Path(path)
    parent_fd, name = _open_safe_parent(root, target, create=False)
    descriptor = -1
    try:
        state = _target_state(parent_fd, name)
        if state is None or not stat.S_ISREG(state.st_mode):
            raise PreferenceIntegrityError(f"secure read target must be a regular file: {target}")
        descriptor = os.open(name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=parent_fd)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        os.close(parent_fd)


def _durable_delete(path: Path, *, data_root: Path) -> None:
    try:
        parent_fd, name = _open_safe_parent(data_root, path, create=False)
    except FileNotFoundError:
        return
    try:
        state = _target_state(parent_fd, name)
        if state is None:
            return
        if not stat.S_ISREG(state.st_mode):
            raise PreferenceIntegrityError(f"transaction target must be a regular file: {path}")
        os.unlink(name, dir_fd=parent_fd)
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


class DataRootLock:
    """A re-entrant POSIX advisory lock scoped to one preference data root."""

    def __init__(self, data_root: str | Path, *, timeout: float = 30.0):
        self.data_root = Path(data_root).resolve()
        self.path = self.data_root / "local" / "data.lock"
        self.timeout = timeout
        self._state: dict[str, Any] | None = None

    def __enter__(self) -> "DataRootLock":
        if fcntl is None:
            raise PreferenceStorageError(
                "cross-process preference locking is unsupported on this platform",
                code="unsupported_lock_platform",
            )
        self.data_root.mkdir(parents=True, exist_ok=True)
        if self.path.parent.is_symlink() or (self.path.parent.exists() and not self.path.parent.is_dir()):
            raise PreferenceIntegrityError("preference local directory is unsafe")
        self.path.parent.mkdir(mode=0o700, exist_ok=True)
        with _LOCK_STATES_GUARD:
            state = _LOCK_STATES.get(self.path)
            if state is None or state.get("pid") != os.getpid():
                state = {"pid": os.getpid(), "mutex": threading.RLock(), "depth": 0, "fd": None}
                _LOCK_STATES[self.path] = state
        state["mutex"].acquire()
        self._state = state
        if state["depth"] > 0:
            state["depth"] += 1
            return self
        descriptor = -1
        try:
            descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
            os.fchmod(descriptor, 0o600)
            deadline = time.monotonic() + self.timeout
            while True:
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as exc:
                    if exc.errno not in {errno.EACCES, errno.EAGAIN}:
                        raise PreferenceStorageError(f"cannot lock preference data root: {exc}") from exc
                    if time.monotonic() >= deadline:
                        raise PreferenceConflictError(
                            "timed out waiting for the preference data-root lock",
                            code="lock_timeout",
                            retryable=True,
                        )
                    time.sleep(0.025)
        except Exception:
            if descriptor >= 0:
                os.close(descriptor)
            state["fd"] = None
            state["depth"] = 0
            state["mutex"].release()
            self._state = None
            raise
        state["fd"] = descriptor
        state["depth"] = 1
        return self

    def __exit__(self, *_args: object) -> None:
        state = self._state
        if state is None:
            return
        state["depth"] -= 1
        if state["depth"] == 0:
            descriptor = state["fd"]
            state["fd"] = None
            try:
                assert descriptor is not None and fcntl is not None
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)
        state["mutex"].release()
        self._state = None


def secure_atomic_delete(data_root: str | Path, path: str | Path) -> None:
    _durable_delete(Path(path), data_root=Path(data_root).resolve())


def data_root_lock(data_root: str | Path, *, timeout: float = 30.0) -> DataRootLock:
    return DataRootLock(data_root, timeout=timeout)


def _relative(data_root: Path, path: Path) -> str:
    lexical = Path(os.path.abspath(path))
    try:
        relative = lexical.relative_to(data_root)
    except ValueError as exc:
        raise PreferenceIntegrityError(f"transaction path escapes data root: {path}") from exc
    if not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
        raise PreferenceIntegrityError(f"transaction path is invalid: {path}")
    return relative.as_posix()


def _safe_repo_relative(value: str) -> str:
    path = Path(value)
    if (
        not value
        or path.is_absolute()
        or "\\" in value
        or "\x00" in value
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise PreferenceRecoveryError("transaction repo_path is unsafe")
    return path.as_posix()


def _managed_relative(relative: str, repo_relative: str | None) -> bool:
    if relative in {"config.json", "device.json"}:
        return True
    if relative.startswith("local/"):
        return relative != "local/data.lock" and not relative.startswith("local/transactions/")
    if repo_relative is None:
        return False
    prefix = f"{repo_relative}/"
    if not relative.startswith(prefix):
        return False
    generated = relative[len(prefix):]
    return (
        generated in {"groups.json", "version.json", "evidence", "changes"}
        or generated.startswith("evidence/")
        or generated.startswith("changes/")
    )


def _snapshot(path: Path) -> dict[str, Any]:
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise PreferenceIntegrityError(f"transaction path must be a regular file: {path}")
    if not path.exists():
        return {"exists": False, "digest": None, "blob": None}
    content = path.read_bytes()
    digest = stable_hash(content)
    return {"exists": True, "digest": digest, "blob": digest}


def _snapshot_matches(path: Path, snapshot: Mapping[str, Any]) -> bool:
    exists = bool(snapshot["exists"])
    if path.is_symlink() or (path.exists() and not path.is_file()):
        return False
    if not exists:
        return not path.exists()
    return path.exists() and stable_hash(path.read_bytes()) == snapshot["digest"]


def _safe_oid(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40,64}", value):
        raise PreferenceIntegrityError(f"{label} must be a Git object ID")
    return value


def _safe_ref(value: Any, label: str) -> str:
    if (
        not isinstance(value, str)
        or not _REF_RE.fullmatch(value)
        or ".." in value
        or "@{" in value
        or value.endswith(("/", "."))
    ):
        raise PreferenceIntegrityError(f"{label} must be a normalized branch or remote-tracking ref")
    return value


def _validate_sync_basis_contract(
    value: Mapping[str, Any] | None,
    *,
    required: bool,
) -> dict[str, Any] | None:
    if value is None:
        if required:
            raise PreferenceIntegrityError("git_sync transaction requires sync_basis")
        return None
    if not isinstance(value, Mapping) or isinstance(value, list):
        raise PreferenceIntegrityError("sync_basis must be an object")
    data = dict(value)
    keys = {
        "local_ref", "base_head_oid", "upstream_ref", "upstream_oid",
        "merge_base_oid", "base_tree_oid", "local_commits",
    }
    if set(data) != keys:
        raise PreferenceIntegrityError("sync_basis has an invalid shape")
    local_commits = data["local_commits"]
    if not isinstance(local_commits, list):
        raise PreferenceIntegrityError("sync_basis.local_commits must be a list")
    normalized_commits: list[dict[str, str]] = []
    for item in local_commits:
        if not isinstance(item, Mapping) or isinstance(item, list) or set(item) != {"oid", "patch_id"}:
            raise PreferenceIntegrityError("sync_basis local commit has an invalid shape")
        normalized_commits.append({
            "oid": _safe_oid(item["oid"], "sync_basis.local_commit.oid"),
            "patch_id": _safe_oid(item["patch_id"], "sync_basis.local_commit.patch_id"),
        })
    if len({item["oid"] for item in normalized_commits}) != len(normalized_commits):
        raise PreferenceIntegrityError("sync_basis local commits contain duplicate OIDs")
    return {
        "local_ref": _safe_ref(data["local_ref"], "sync_basis.local_ref"),
        "base_head_oid": _safe_oid(data["base_head_oid"], "sync_basis.base_head_oid"),
        "upstream_ref": _safe_ref(data["upstream_ref"], "sync_basis.upstream_ref"),
        "upstream_oid": _safe_oid(data["upstream_oid"], "sync_basis.upstream_oid"),
        "merge_base_oid": _safe_oid(data["merge_base_oid"], "sync_basis.merge_base_oid"),
        "base_tree_oid": _safe_oid(data["base_tree_oid"], "sync_basis.base_tree_oid"),
        "local_commits": normalized_commits,
    }


def _iter_root_files(data_root: Path, relative_root: str) -> Iterable[Path]:
    root = data_root / relative_root
    if root.is_symlink():
        raise PreferenceRecoveryError(f"transaction root is a symlink: {relative_root}")
    if root.is_file():
        yield root
        return
    if not root.exists():
        return
    if not root.is_dir():
        raise PreferenceRecoveryError(f"transaction root is invalid: {relative_root}")
    for path in root.rglob("*"):
        relative = path.relative_to(data_root).as_posix()
        if relative == "local/data.lock" or relative.startswith("local/transactions/"):
            continue
        if path.is_symlink():
            raise PreferenceRecoveryError(f"transaction root contains a symlink: {relative}")
        if path.is_file():
            yield path


@dataclass
class PersistentTransaction:
    data_root: Path
    directory: Path
    manifest: dict[str, Any]

    @classmethod
    def begin(
        cls,
        data_root: str | Path,
        *,
        kind: str,
        roots: Iterable[str | Path],
        repo: str | Path | None = None,
        base_head: str | None = None,
        transaction_id: str | None = None,
        sync_basis: Mapping[str, Any] | None = None,
    ) -> "PersistentTransaction":
        root = Path(data_root).resolve()
        if kind not in TRANSACTION_KINDS:
            raise PreferenceIntegrityError(f"unsupported transaction kind: {kind}")
        normalized_sync_basis = _validate_sync_basis_contract(sync_basis, required=kind == "git_sync")
        if kind != "git_sync" and normalized_sync_basis is not None:
            raise PreferenceIntegrityError("sync_basis is only valid for git_sync transactions")
        if normalized_sync_basis is not None and normalized_sync_basis["base_head_oid"] != base_head:
            raise PreferenceIntegrityError("sync_basis base_head_oid does not match transaction base_head")
        repo_relative = _relative(root, Path(repo)) if repo is not None else None
        if repo_relative is not None:
            repo_relative = _safe_repo_relative(repo_relative)
        relative_roots = sorted({_relative(root, Path(item)) for item in roots})
        for relative in relative_roots:
            if not (
                relative in {"config.json", "device.json", "local"}
                or _managed_relative(relative, repo_relative)
                or relative.startswith("local/")
            ):
                raise PreferenceIntegrityError(f"transaction root is not managed: {relative}")
        identifier = transaction_id or new_id("txn-")
        if not isinstance(identifier, str) or not _ID_RE.fullmatch(identifier):
            raise PreferenceIntegrityError("transaction_id must be a path-safe identifier")
        transaction_root = root / "local" / "transactions"
        directory = transaction_root / identifier
        if directory.exists() or directory.is_symlink():
            raise PreferenceIntegrityError(f"transaction already exists: {identifier}")
        staging_name = f".{identifier}.creating-{new_id()}"
        staging = transaction_root / staging_name
        parent_fd, _placeholder = _open_safe_parent(root, staging / "blobs" / ".placeholder", create=True)
        os.close(parent_fd)
        entries: dict[str, Any] = {}
        for relative_root in relative_roots:
            for path in _iter_root_files(root, relative_root):
                relative = _relative(root, path)
                if not _managed_relative(relative, repo_relative):
                    raise PreferenceIntegrityError(f"transaction path is not managed: {relative}")
                before = _snapshot(path)
                entries[relative] = {"before": before, "after": None}
                if before["exists"]:
                    _durable_write(staging / "blobs" / before["blob"], path.read_bytes(), data_root=root)
        manifest = {
            "schema_version": TRANSACTION_SCHEMA_VERSION,
            "transaction_id": identifier,
            "kind": kind,
            "state": "pending",
            "created_at": utc_now(),
            "repo_path": repo_relative,
            "base_head": base_head,
            "commit_oid": None,
            "sync_basis": normalized_sync_basis,
            "roots": relative_roots,
            "entries": entries,
        }
        transaction = cls(root, staging, manifest)
        transaction._write_manifest()
        transaction_parent_fd, final_name = _open_safe_parent(root, directory, create=True)
        try:
            os.rename(staging.name, final_name, src_dir_fd=transaction_parent_fd, dst_dir_fd=transaction_parent_fd)
            os.fsync(transaction_parent_fd)
        except OSError as exc:
            raise PreferenceStorageError(f"cannot publish transaction journal: {exc}") from exc
        finally:
            os.close(transaction_parent_fd)
        transaction.directory = directory
        return transaction

    @classmethod
    def begin_local(
        cls,
        data_root: str | Path,
        writes: Mapping[str | Path, bytes | None],
        *,
        transaction_id: str | None = None,
    ) -> "PersistentTransaction":
        root = Path(data_root).resolve()
        paths = [Path(path) if Path(path).is_absolute() else root / Path(path) for path in writes]
        transaction = cls.begin(
            root,
            kind="local",
            roots=paths,
            transaction_id=transaction_id,
        )
        for raw_path, content in writes.items():
            path = Path(raw_path) if Path(raw_path).is_absolute() else root / Path(raw_path)
            transaction.record_after(path, content)
        return transaction

    @property
    def transaction_id(self) -> str:
        return str(self.manifest["transaction_id"])

    @property
    def marker(self) -> str:
        return f"[preference-transaction: {self.transaction_id}]"

    def _write_manifest(self) -> None:
        _durable_write(
            self.directory / "manifest.json",
            (stable_json_dumps(self.manifest) + "\n").encode("utf-8"),
            data_root=self.data_root,
        )

    def _write_blob(self, content: bytes) -> str:
        digest = stable_hash(content)
        path = self.directory / "blobs" / digest
        if path.exists():
            if path.is_symlink() or not path.is_file() or path.read_bytes() != content:
                raise PreferenceIntegrityError(f"transaction blob conflict: {digest}")
        else:
            _durable_write(path, content, data_root=self.data_root)
        return digest

    def record_after(self, path: str | Path, content: bytes | None) -> None:
        target = Path(os.path.abspath(path))
        relative = _relative(self.data_root, target)
        repo_relative = self.manifest["repo_path"]
        if not _managed_relative(relative, repo_relative):
            raise PreferenceIntegrityError(f"transaction path is not managed: {relative}")
        entries = self.manifest["entries"]
        if relative not in entries:
            entries[relative] = {"before": _snapshot(target), "after": None}
            before = entries[relative]["before"]
            if before["exists"]:
                self._write_blob(target.read_bytes())
        if content is None:
            after = {"exists": False, "digest": None, "blob": None}
        else:
            digest = self._write_blob(content)
            after = {"exists": True, "digest": digest, "blob": digest}
        entries[relative]["after"] = after
        self._write_manifest()

    def record_recovered_entry(
        self,
        path: str | Path,
        *,
        before_content: bytes | None,
        after_content: bytes | None,
    ) -> None:
        target = Path(os.path.abspath(path))
        relative = _relative(self.data_root, target)
        if not _managed_relative(relative, self.manifest["repo_path"]):
            raise PreferenceRecoveryError(f"recovered transaction path is not managed: {relative}")

        def image(content: bytes | None) -> dict[str, Any]:
            if content is None:
                return {"exists": False, "digest": None, "blob": None}
            digest = self._write_blob(content)
            return {"exists": True, "digest": digest, "blob": digest}

        self.manifest["entries"][relative] = {
            "before": image(before_content),
            "after": image(after_content),
        }
        self._write_manifest()

    def activate(self) -> None:
        current = getattr(_ACTIVE, "transaction", None)
        if current is not None and current is not self:
            raise PreferenceIntegrityError("nested persistent transactions are not supported")
        _ACTIVE.transaction = self

    def deactivate(self) -> None:
        if getattr(_ACTIVE, "transaction", None) is self:
            _ACTIVE.transaction = None

    def apply(self) -> None:
        self.activate()
        try:
            for relative, entry in sorted(self.manifest["entries"].items()):
                after = entry["after"]
                if after is None:
                    continue
                path = self.data_root / relative
                if after["exists"]:
                    _durable_write(
                        path,
                        (self.directory / "blobs" / after["blob"]).read_bytes(),
                        data_root=self.data_root,
                    )
                else:
                    _durable_delete(path, data_root=self.data_root)
        finally:
            self.deactivate()

    def commit_local(self) -> None:
        if self.manifest["kind"] != "local":
            raise PreferenceIntegrityError("commit_local requires a local transaction")
        self.manifest["state"] = "committed"
        self._write_manifest()
        self.cleanup()

    def prepare_git_sync_after(self, current_head: str | None) -> None:
        if self.manifest["kind"] != "git_sync" or current_head is None:
            raise PreferenceRecoveryError("prepare_git_sync_after requires a Git synchronization HEAD")
        _prepare_git_after_images(self, current_head, require_marker=False)

    def record_commit_oid(self, current_head: str | None) -> None:
        if current_head is not None and not re.fullmatch(r"[0-9a-f]{40,64}", current_head):
            raise PreferenceRecoveryError("Git transaction commit OID is invalid")
        self.manifest["commit_oid"] = current_head
        self._write_manifest()

    def commit_git(self, current_head: str | None) -> None:
        if self.manifest["kind"] not in {"git", "git_sync"}:
            raise PreferenceIntegrityError("commit_git requires a Git-backed transaction")
        base_head = self.manifest["base_head"]
        changed = current_head != base_head
        if self.manifest["commit_oid"] != current_head:
            raise PreferenceRecoveryError("Git transaction commit OID was not persisted")
        if self.manifest["kind"] == "git_sync":
            _validate_git_sync(self, current_head)
        elif changed:
            _validate_git_commit(self, current_head)
        elif any(
            relative.startswith(f"{self.manifest['repo_path']}/")
            and entry["after"] is not None
            and entry["after"] != entry["before"]
            for relative, entry in self.manifest["entries"].items()
        ):
            raise PreferenceRecoveryError("Git transaction changed repository files without creating a commit")
        self.manifest["state"] = "committed"
        self._write_manifest()
        self.cleanup()

    def rollback(self) -> None:
        self.deactivate()
        _validate_current_entries(self)
        for relative, entry in sorted(self.manifest["entries"].items(), reverse=True):
            path = self.data_root / relative
            before = entry["before"]
            if before["exists"]:
                _durable_write(
                    path,
                    (self.directory / "blobs" / before["blob"]).read_bytes(),
                    data_root=self.data_root,
                )
            else:
                _durable_delete(path, data_root=self.data_root)
        self.cleanup()

    def cleanup(self) -> None:
        self.deactivate()
        if self.directory.is_symlink():
            raise PreferenceRecoveryError(f"transaction directory is a symlink: {self.directory}")
        if self.directory.exists():
            try:
                _secure_remove_tree(self.data_root, self.directory)
            except (OSError, PreferenceIntegrityError) as exc:
                raise PreferenceRecoveryError(
                    f"cannot safely remove transaction directory: {self.directory}"
                ) from exc


def active_transaction_for(path: str | Path) -> PersistentTransaction | None:
    transaction = getattr(_ACTIVE, "transaction", None)
    if transaction is None:
        return None
    target = Path(os.path.abspath(path))
    try:
        target.relative_to(transaction.data_root)
    except ValueError:
        return None
    return transaction


def record_active_write(path: str | Path, content: bytes) -> None:
    transaction = active_transaction_for(path)
    if transaction is not None:
        transaction.record_after(path, content)


def record_active_delete(path: str | Path) -> None:
    transaction = active_transaction_for(path)
    if transaction is not None:
        transaction.record_after(path, None)


def _validate_snapshot(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"exists", "digest", "blob"}:
        raise PreferenceRecoveryError(f"{label} has an invalid shape")
    if not isinstance(value["exists"], bool):
        raise PreferenceRecoveryError(f"{label}.exists must be a boolean")
    if value["exists"]:
        if not isinstance(value["digest"], str) or not _HASH_RE.fullmatch(value["digest"]):
            raise PreferenceRecoveryError(f"{label}.digest is invalid")
        if value["blob"] != value["digest"]:
            raise PreferenceRecoveryError(f"{label}.blob is invalid")
    elif value["digest"] is not None or value["blob"] is not None:
        raise PreferenceRecoveryError(f"{label} missing snapshot must have null digest and blob")
    return value


def _load_transaction(directory: Path, data_root: Path) -> PersistentTransaction:
    manifest_path = directory / "manifest.json"
    if directory.is_symlink() or not directory.is_dir() or manifest_path.is_symlink() or not manifest_path.is_file():
        raise PreferenceRecoveryError(f"transaction journal is unsafe: {directory}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreferenceRecoveryError(f"cannot read transaction journal: {directory}: {exc}") from exc
    keys = {
        "schema_version", "transaction_id", "kind", "state", "created_at",
        "repo_path", "base_head", "commit_oid", "sync_basis", "roots", "entries",
    }
    if not isinstance(manifest, dict) or set(manifest) != keys:
        raise PreferenceRecoveryError("transaction manifest has an invalid shape")
    if manifest["schema_version"] != TRANSACTION_SCHEMA_VERSION:
        raise PreferenceRecoveryError("transaction schema_version is unsupported")
    if manifest["transaction_id"] != directory.name or not _ID_RE.fullmatch(directory.name):
        raise PreferenceRecoveryError("transaction ID is invalid")
    if manifest["kind"] not in TRANSACTION_KINDS or manifest["state"] not in TRANSACTION_STATES:
        raise PreferenceRecoveryError("transaction kind or state is invalid")
    repo_relative = manifest["repo_path"]
    if repo_relative is not None:
        if not isinstance(repo_relative, str):
            raise PreferenceRecoveryError("transaction repo_path is invalid")
        repo_relative = _safe_repo_relative(repo_relative)
    if manifest["kind"] in {"git", "git_sync"} and repo_relative is None:
        raise PreferenceRecoveryError("Git-backed transaction requires repo_path")
    try:
        manifest["sync_basis"] = _validate_sync_basis_contract(
            manifest["sync_basis"],
            required=manifest["kind"] == "git_sync",
        )
    except PreferenceIntegrityError as exc:
        raise PreferenceRecoveryError(str(exc)) from exc
    if manifest["kind"] != "git_sync" and manifest["sync_basis"] is not None:
        raise PreferenceRecoveryError("non-sync transaction cannot contain sync_basis")
    if manifest["base_head"] is not None and (
        not isinstance(manifest["base_head"], str)
        or not re.fullmatch(r"[0-9a-f]{40,64}", manifest["base_head"])
    ):
        raise PreferenceRecoveryError("transaction base_head is invalid")
    if manifest["commit_oid"] is not None and (
        not isinstance(manifest["commit_oid"], str)
        or not re.fullmatch(r"[0-9a-f]{40,64}", manifest["commit_oid"])
    ):
        raise PreferenceRecoveryError("transaction commit_oid is invalid")
    if not isinstance(manifest["roots"], list) or not all(isinstance(item, str) for item in manifest["roots"]):
        raise PreferenceRecoveryError("transaction roots are invalid")
    for relative in manifest["roots"]:
        if relative.startswith("/") or ".." in Path(relative).parts:
            raise PreferenceRecoveryError("transaction root is unsafe")
    if not isinstance(manifest["entries"], dict):
        raise PreferenceRecoveryError("transaction entries are invalid")
    for relative, entry in manifest["entries"].items():
        if not isinstance(relative, str) or not _managed_relative(relative, repo_relative):
            raise PreferenceRecoveryError(f"transaction entry is not managed: {relative!r}")
        if not isinstance(entry, dict) or set(entry) != {"before", "after"}:
            raise PreferenceRecoveryError("transaction entry has an invalid shape")
        for name in ("before", "after"):
            if entry[name] is not None:
                snapshot = _validate_snapshot(entry[name], f"transaction entry {name}")
                if snapshot["exists"]:
                    blob = directory / "blobs" / snapshot["blob"]
                    if blob.is_symlink() or not blob.is_file() or stable_hash(blob.read_bytes()) != snapshot["digest"]:
                        raise PreferenceRecoveryError("transaction blob failed integrity validation")
    return PersistentTransaction(data_root, directory, manifest)


def _validate_current_entries(transaction: PersistentTransaction) -> None:
    entries = transaction.manifest["entries"]
    for relative in entries:
        try:
            parent_fd, _name = _open_safe_parent(
                transaction.data_root,
                transaction.data_root / relative,
                create=False,
            )
        except FileNotFoundError:
            if not entries[relative]["before"]["exists"] and not (transaction.data_root / relative).exists():
                continue
            raise PreferenceRecoveryError(
                f"transaction recovery found a missing parent path: {relative}"
            )
        except (OSError, PreferenceIntegrityError) as exc:
            raise PreferenceRecoveryError(
                f"transaction recovery found an unsafe parent path: {relative}"
            ) from exc
        else:
            os.close(parent_fd)
    known = set(entries)
    for relative_root in transaction.manifest["roots"]:
        for path in _iter_root_files(transaction.data_root, relative_root):
            relative = _relative(transaction.data_root, path)
            if relative not in known:
                raise PreferenceRecoveryError(f"transaction recovery found an unknown file: {relative}")
    for relative, entry in entries.items():
        path = transaction.data_root / relative
        before = entry["before"]
        after = entry["after"]
        if _snapshot_matches(path, before):
            continue
        if after is not None and _snapshot_matches(path, after):
            continue
        raise PreferenceRecoveryError(f"transaction recovery found unknown content: {relative}")


def _git_head(repo: Path) -> str | None:
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def _git_output(repo: Path, args: list[str]) -> bytes:
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise PreferenceRecoveryError(
            f"cannot validate Git transaction commit: {result.stderr.decode('utf-8', errors='replace')[:300]}"
        )
    return result.stdout


def _commit_patch_id(repo: Path, commit_oid: str) -> str:
    import subprocess

    patch = subprocess.run(
        ["git", "-C", str(repo), "show", "--format=", "--binary", commit_oid],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if patch.returncode != 0:
        raise PreferenceRecoveryError("cannot read a local commit while preparing Git synchronization")
    identified = subprocess.run(
        ["git", "-C", str(repo), "patch-id", "--stable"],
        input=patch.stdout,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    fields = identified.stdout.decode("ascii", errors="replace").strip().split()
    if identified.returncode != 0 or len(fields) != 2 or not re.fullmatch(r"[0-9a-f]{40,64}", fields[0]):
        raise PreferenceRecoveryError("local synchronization commit has no stable patch identity")
    return fields[0]


def build_git_sync_basis(
    repo: str | Path,
    *,
    local_ref: str,
    upstream_ref: str,
    base_head: str,
) -> dict[str, Any]:
    """Freeze the fetched upstream and local replay set before rebase starts."""

    path = Path(repo).resolve()
    normalized_local_ref = _safe_ref(local_ref, "sync_basis.local_ref")
    normalized_upstream_ref = _safe_ref(upstream_ref, "sync_basis.upstream_ref")
    base_oid = _safe_oid(base_head, "sync_basis.base_head")
    current_local = _git_output(path, ["rev-parse", f"{normalized_local_ref}^{{commit}}"]).decode("ascii").strip()
    if current_local != base_oid:
        raise PreferenceRecoveryError("local branch ref changed before synchronization")
    upstream_oid = _git_output(path, ["rev-parse", f"{normalized_upstream_ref}^{{commit}}"]).decode("ascii").strip()
    _safe_oid(upstream_oid, "sync_basis.upstream_oid")
    merge_base = _git_output(path, ["merge-base", base_oid, upstream_oid]).decode("ascii").strip()
    _safe_oid(merge_base, "sync_basis.merge_base_oid")
    base_tree = _git_output(path, ["rev-parse", f"{base_oid}^{{tree}}"]).decode("ascii").strip()
    _safe_oid(base_tree, "sync_basis.base_tree_oid")
    import subprocess

    index = subprocess.run(
        ["git", "-C", str(path), "diff", "--cached", "--quiet", base_oid],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if index.returncode != 0:
        raise PreferenceRecoveryError("Git index does not match the pre-sync local HEAD")
    commits_output = _git_output(
        path,
        ["rev-list", "--reverse", "--first-parent", f"{merge_base}..{base_oid}"],
    ).decode("ascii")
    local_commits: list[dict[str, str]] = []
    for commit_oid in [line for line in commits_output.splitlines() if line]:
        parents = _git_output(path, ["rev-list", "--parents", "-n", "1", commit_oid]).decode("ascii").split()
        if len(parents) != 2:
            raise PreferenceRecoveryError("Git synchronization does not support replaying merge commits")
        local_commits.append({"oid": commit_oid, "patch_id": _commit_patch_id(path, commit_oid)})
    return _validate_sync_basis_contract({
        "local_ref": normalized_local_ref,
        "base_head_oid": base_oid,
        "upstream_ref": normalized_upstream_ref,
        "upstream_oid": upstream_oid,
        "merge_base_oid": merge_base,
        "base_tree_oid": base_tree,
        "local_commits": local_commits,
    }, required=True) or {}


def _validate_after_entries(transaction: PersistentTransaction) -> None:
    _validate_current_entries(transaction)
    for relative, entry in transaction.manifest["entries"].items():
        after = entry["after"]
        if after is None:
            raise PreferenceRecoveryError(f"transaction after image is missing: {relative}")
        if not _snapshot_matches(transaction.data_root / relative, after):
            raise PreferenceRecoveryError(f"transaction after image does not match current content: {relative}")


def _git_changed_paths(repo: Path, base_head: str | None, commit_oid: str) -> set[str]:
    if base_head is None:
        output = _git_output(
            repo,
            ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", commit_oid],
        )
    else:
        output = _git_output(repo, ["diff", "--name-only", base_head, commit_oid])
    return {line for line in output.decode("utf-8").splitlines() if line}


def _git_blob(repo: Path, commit_oid: str | None, path: str) -> bytes | None:
    if commit_oid is None:
        return None
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(repo), "show", f"{commit_oid}:{path}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def _validate_generated_parent(repo: Path, base_head: str | None, commit_oid: str) -> None:
    row = _git_output(repo, ["rev-list", "--parents", "-n", "1", commit_oid]).decode("ascii").strip().split()
    expected = [commit_oid] if base_head is None else [commit_oid, base_head]
    if row != expected:
        raise PreferenceRecoveryError("generated Git transaction commit parent does not match its base HEAD")


def _validate_git_sync_base_state(transaction: PersistentTransaction) -> None:
    basis = transaction.manifest["sync_basis"]
    if not isinstance(basis, dict):
        raise PreferenceRecoveryError("Git synchronization basis is missing")
    repo = transaction.data_root / transaction.manifest["repo_path"]
    base_head = transaction.manifest["base_head"]
    if base_head is None or basis["base_head_oid"] != base_head or _git_head(repo) != base_head:
        raise PreferenceRecoveryError("Git synchronization did not return to its frozen base HEAD")
    if _git_output(repo, ["rev-parse", f"{basis['local_ref']}^{{commit}}"]).decode("ascii").strip() != base_head:
        raise PreferenceRecoveryError("local branch ref did not return to the pre-sync HEAD")
    import subprocess

    index = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached", "--quiet", base_head],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if index.returncode != 0:
        raise PreferenceRecoveryError("Git index did not return to the pre-sync tree")


def _validate_git_sync_basis(transaction: PersistentTransaction, commit_oid: str) -> None:
    basis = transaction.manifest["sync_basis"]
    if not isinstance(basis, dict):
        raise PreferenceRecoveryError("Git synchronization basis is missing")
    repo = transaction.data_root / transaction.manifest["repo_path"]
    base_head = transaction.manifest["base_head"]
    if base_head is None or basis["base_head_oid"] != base_head:
        raise PreferenceRecoveryError("Git synchronization base HEAD does not match its frozen basis")
    if _git_output(repo, ["rev-parse", f"{basis['local_ref']}^{{commit}}"]).decode("ascii").strip() != commit_oid:
        raise PreferenceRecoveryError("local branch ref does not point to the synchronized HEAD")
    if _git_output(repo, ["rev-parse", f"{basis['upstream_ref']}^{{commit}}"]).decode("ascii").strip() != basis["upstream_oid"]:
        raise PreferenceRecoveryError("upstream ref changed after the synchronization basis was frozen")
    base_tree = _git_output(repo, ["rev-parse", f"{base_head}^{{tree}}"]).decode("ascii").strip()
    if base_tree != basis["base_tree_oid"]:
        raise PreferenceRecoveryError("pre-sync base tree no longer matches the synchronization basis")
    merge_base = _git_output(repo, ["merge-base", base_head, basis["upstream_oid"]]).decode("ascii").strip()
    if merge_base != basis["merge_base_oid"]:
        raise PreferenceRecoveryError("pre-sync merge base no longer matches the synchronization basis")
    original_output = _git_output(
        repo,
        ["rev-list", "--reverse", "--first-parent", f"{merge_base}..{base_head}"],
    ).decode("ascii")
    if [line for line in original_output.splitlines() if line] != [item["oid"] for item in basis["local_commits"]]:
        raise PreferenceRecoveryError("pre-sync local commit set no longer matches the synchronization basis")
    import subprocess

    ancestor = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", basis["upstream_oid"], commit_oid],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if ancestor.returncode != 0:
        raise PreferenceRecoveryError("synchronized Git HEAD does not contain the frozen upstream commit")
    replayed_output = _git_output(
        repo,
        ["rev-list", "--reverse", "--first-parent", f"{basis['upstream_oid']}..{commit_oid}"],
    ).decode("ascii")
    replayed = [line for line in replayed_output.splitlines() if line]
    expected = basis["local_commits"]
    if len(replayed) != len(expected):
        raise PreferenceRecoveryError("synchronized Git HEAD has an unexpected replay commit count")
    for commit, expected_commit in zip(replayed, expected):
        parents = _git_output(repo, ["rev-list", "--parents", "-n", "1", commit]).decode("ascii").split()
        if len(parents) != 2:
            raise PreferenceRecoveryError("synchronized Git history contains an unexpected merge commit")
        if _commit_patch_id(repo, commit) != expected_commit["patch_id"]:
            raise PreferenceRecoveryError("synchronized Git replay patch does not match the frozen local commit")
    index = subprocess.run(
        ["git", "-C", str(repo), "diff", "--cached", "--quiet", commit_oid],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if index.returncode != 0:
        raise PreferenceRecoveryError("Git index does not match the synchronized HEAD")


def _path_is_covered(transaction: PersistentTransaction, relative: str) -> bool:
    return any(relative == root or relative.startswith(f"{root}/") for root in transaction.manifest["roots"])


def _snapshot_content(transaction: PersistentTransaction, snapshot: Mapping[str, Any]) -> bytes | None:
    if not snapshot["exists"]:
        return None
    return (transaction.directory / "blobs" / snapshot["blob"]).read_bytes()


def _prepare_git_after_images(
    transaction: PersistentTransaction,
    commit_oid: str,
    *,
    require_marker: bool,
) -> None:
    repo_relative = transaction.manifest["repo_path"]
    repo = transaction.data_root / repo_relative
    base_head = transaction.manifest["base_head"]
    if require_marker:
        subject = _git_output(repo, ["show", "-s", "--format=%s", commit_oid]).decode(
            "utf-8", errors="replace",
        ).strip()
        if transaction.marker not in subject:
            raise PreferenceRecoveryError("Git transaction commit subject marker does not match")
        _validate_generated_parent(repo, base_head, commit_oid)
    else:
        _validate_git_sync_basis(transaction, commit_oid)
    changed_paths = _git_changed_paths(repo, base_head, commit_oid)
    prefix = f"{repo_relative}/"
    for repo_path in changed_paths:
        relative = f"{prefix}{repo_path}"
        if not _managed_relative(relative, repo_relative) or not _path_is_covered(transaction, relative):
            raise PreferenceRecoveryError(f"Git transaction changed an unjournalled path: {repo_path}")
        before_content = _git_blob(repo, base_head, repo_path)
        after_content = _git_blob(repo, commit_oid, repo_path)
        entry = transaction.manifest["entries"].get(relative)
        if entry is None:
            transaction.record_recovered_entry(
                transaction.data_root / relative,
                before_content=before_content,
                after_content=after_content,
            )
            continue
        before = entry["before"]
        expected_before = None if before_content is None else stable_hash(before_content)
        if before["exists"] != (before_content is not None) or before["digest"] != expected_before:
            raise PreferenceRecoveryError(f"Git transaction base blob does not match journal: {repo_path}")
        if entry["after"] is None:
            transaction.record_after(transaction.data_root / relative, after_content)
    for relative, entry in list(transaction.manifest["entries"].items()):
        if entry["after"] is not None:
            continue
        if relative.startswith(prefix) and relative[len(prefix):] in changed_paths:
            raise PreferenceRecoveryError(f"Git transaction after image is missing: {relative}")
        transaction.record_after(
            transaction.data_root / relative,
            _snapshot_content(transaction, entry["before"]),
        )


def _validate_git_paths_and_blobs(transaction: PersistentTransaction, commit_oid: str) -> None:
    repo_relative = transaction.manifest["repo_path"]
    repo = transaction.data_root / repo_relative
    changed_paths = _git_changed_paths(repo, transaction.manifest["base_head"], commit_oid)
    prefix = f"{repo_relative}/"
    expected_paths = {
        relative[len(prefix):]
        for relative, entry in transaction.manifest["entries"].items()
        if relative.startswith(prefix) and entry["after"] != entry["before"]
    }
    if changed_paths != expected_paths:
        raise PreferenceRecoveryError(
            f"Git transaction changed paths do not match journal: expected {sorted(expected_paths)}, found {sorted(changed_paths)}"
        )
    for repo_path in expected_paths:
        entry = transaction.manifest["entries"][f"{prefix}{repo_path}"]
        after = entry["after"]
        if after is None:
            raise PreferenceRecoveryError(f"Git transaction after image is missing: {repo_path}")
        content = _git_blob(repo, commit_oid, repo_path)
        if after["exists"]:
            if content is None or stable_hash(content) != after["digest"]:
                raise PreferenceRecoveryError(f"Git transaction commit blob does not match journal: {repo_path}")
        elif content is not None:
            raise PreferenceRecoveryError(f"Git transaction commit retained a journalled deletion: {repo_path}")
    _validate_after_entries(transaction)


def _validate_git_commit(transaction: PersistentTransaction, commit_oid: str | None) -> None:
    if commit_oid is None:
        raise PreferenceRecoveryError("Git transaction commit OID is missing")
    repo = transaction.data_root / transaction.manifest["repo_path"]
    subject = _git_output(repo, ["show", "-s", "--format=%s", commit_oid]).decode("utf-8", errors="replace").strip()
    if transaction.marker not in subject:
        raise PreferenceRecoveryError("Git transaction commit subject marker does not match")
    _validate_generated_parent(repo, transaction.manifest["base_head"], commit_oid)
    _validate_git_paths_and_blobs(transaction, commit_oid)


def _validate_git_sync(transaction: PersistentTransaction, commit_oid: str | None) -> None:
    if commit_oid is None:
        raise PreferenceRecoveryError("Git synchronization commit OID is missing")
    _validate_git_sync_basis(transaction, commit_oid)
    _validate_git_paths_and_blobs(transaction, commit_oid)


def _rebase_in_progress(repo: Path) -> bool:
    git_dir = repo / ".git"
    return any((git_dir / name).exists() for name in ("rebase-merge", "rebase-apply"))


def _abort_rebase(repo: Path) -> None:
    import subprocess

    result = subprocess.run(
        ["git", "-C", str(repo), "rebase", "--abort"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        raise PreferenceRecoveryError(
            f"cannot abort interrupted preference rebase: {result.stderr.decode('utf-8', errors='replace')[:300]}"
        )


def recover_transactions(data_root: str | Path) -> list[dict[str, str]]:
    """Recover journals while the caller holds the data-root lock."""

    root = Path(data_root).resolve()
    transaction_root = root / "local" / "transactions"
    if transaction_root.is_symlink():
        raise PreferenceRecoveryError("transaction root cannot be a symlink")
    if not transaction_root.exists():
        return []
    if not transaction_root.is_dir():
        raise PreferenceRecoveryError("transaction root must be a directory")
    results: list[dict[str, str]] = []
    creating_pattern = re.compile(r"^\.([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.creating-[A-Za-z0-9._-]+$")
    for directory in sorted(transaction_root.iterdir()):
        if directory.name.startswith("."):
            if not creating_pattern.fullmatch(directory.name) or directory.is_symlink() or not directory.is_dir():
                raise PreferenceRecoveryError(f"unknown transaction staging entry: {directory.name}")
            try:
                _secure_remove_tree(root, directory)
            except (OSError, PreferenceIntegrityError) as exc:
                raise PreferenceRecoveryError(
                    f"cannot safely discard transaction staging entry: {directory.name}"
                ) from exc
            results.append({"transaction_id": directory.name, "result": "discarded_creating"})
            continue
        transaction = _load_transaction(directory, root)
        state = transaction.manifest["state"]
        kind = transaction.manifest["kind"]
        if state == "committed":
            _validate_after_entries(transaction)
            if kind in {"git", "git_sync"}:
                current_head = _git_head(root / transaction.manifest["repo_path"])
                if transaction.manifest["commit_oid"] != current_head:
                    raise PreferenceRecoveryError("committed Git transaction HEAD changed", code="unknown_head")
                if kind == "git":
                    _validate_git_commit(transaction, current_head)
                else:
                    _validate_git_sync(transaction, current_head)
            transaction.cleanup()
            results.append({"transaction_id": transaction.transaction_id, "result": "completed"})
            continue
        if kind in {"git", "git_sync"}:
            repo = root / transaction.manifest["repo_path"]
            base_head = transaction.manifest["base_head"]
            if kind == "git_sync" and _rebase_in_progress(repo):
                _abort_rebase(repo)
                if _git_head(repo) != base_head:
                    raise PreferenceRecoveryError("interrupted rebase did not return to its base HEAD", code="unknown_head")
                _validate_git_sync_base_state(transaction)
                transaction.rollback()
                results.append({"transaction_id": transaction.transaction_id, "result": "rolled_back_rebase"})
                continue
            current_head = _git_head(repo)
            if current_head != base_head:
                commit_oid = transaction.manifest["commit_oid"]
                if commit_oid is None:
                    _prepare_git_after_images(
                        transaction,
                        current_head,
                        require_marker=kind == "git",
                    )
                    transaction.record_commit_oid(current_head)
                elif commit_oid != current_head:
                    raise PreferenceRecoveryError(
                        "cannot recover preference transaction because Git HEAD does not match the persisted commit OID",
                        code="unknown_head",
                    )
                if kind == "git":
                    _validate_git_commit(transaction, current_head)
                else:
                    _validate_git_sync(transaction, current_head)
                transaction.cleanup()
                results.append({"transaction_id": transaction.transaction_id, "result": "committed"})
                continue
        if kind == "git_sync":
            _validate_git_sync_base_state(transaction)
        transaction.rollback()
        results.append({"transaction_id": transaction.transaction_id, "result": "rolled_back"})
    return results


def pending_transactions(data_root: str | Path) -> list[str]:
    """Inspect pending journal IDs without creating directories or recovering them."""

    root = Path(data_root).resolve() / "local" / "transactions"
    if not root.exists():
        return []
    if root.is_symlink() or not root.is_dir():
        raise PreferenceRecoveryError("transaction root is unsafe")
    return sorted(path.name for path in root.iterdir())


def commit_local_files(
    data_root: str | Path,
    writes: Mapping[str | Path, bytes | None],
    *,
    transaction_id: str | None = None,
) -> str:
    root = Path(data_root).resolve()
    with data_root_lock(root):
        recover_transactions(root)
        transaction = PersistentTransaction.begin_local(root, writes, transaction_id=transaction_id)
        try:
            transaction.apply()
            transaction.commit_local()
        except Exception:
            if transaction.directory.exists():
                transaction.rollback()
            raise
        return transaction.transaction_id


def compare_and_swap_json(
    data_root: str | Path,
    path: str | Path,
    *,
    expected_generation: int,
    value: Mapping[str, Any],
    resource: str,
) -> CasState:
    """Atomically replace one generation-bearing JSON object."""

    root = Path(data_root).resolve()
    target = Path(path) if Path(path).is_absolute() else root / Path(path)
    with data_root_lock(root):
        recover_transactions(root)
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise PreferenceIntegrityError(f"CAS target must be a regular file: {target}")
        if target.exists():
            try:
                current = json.loads(target.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PreferenceStorageError(f"cannot read CAS target: {target}: {exc}") from exc
            if not isinstance(current, dict) or type(current.get("generation")) is not int:
                raise PreferenceIntegrityError("CAS target must contain an integer generation")
            current_generation = current["generation"]
        else:
            current_generation = 0
        if current_generation != expected_generation:
            raise PreferenceConflictError(
                f"expected generation {expected_generation}, found {current_generation}",
                code="stale_generation",
            )
        next_value = dict(value)
        if type(next_value.get("generation")) is not int or next_value["generation"] != expected_generation + 1:
            raise PreferenceConflictError(
                "CAS replacement generation must increment by one",
                code="invalid_generation",
            )
        content = (stable_json_dumps(next_value) + "\n").encode("utf-8")
        commit_local_files(root, {target: content})
        return cas_for(resource, next_value["generation"], next_value)
