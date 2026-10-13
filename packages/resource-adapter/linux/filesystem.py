"""Kernel write boundary and private native-operation views."""
import errno
import json
import os
import posixpath
import stat
import time

from fusepy import FuseOSError, Operations, fuse_get_context
from store import Rejected


class Filesystem(Operations):
    def __init__(self, store, workers, operation=None):
        self.store, self.workers = store, workers
        self.operation = operation
        self.owner_uid = store.db.execute("SELECT uid FROM operations WHERE id=?", (operation,)).fetchone()[0] if operation else 0
        self.handles, self.next_handle = {}, 0

    def context(self, writable=False):
        uid = fuse_get_context()[0]
        row = self.store.db.execute("SELECT * FROM operations WHERE uid=? AND status='running'", (uid,)).fetchone()
        if row and self.operation == row["id"]:
            return row["id"], row["owner"]
        if not writable and self.operation is None and (uid == 0 or uid in self.workers or row):
            return None, self.workers.get(uid)
        if not writable and uid == 0:
            return self.operation, None
        raise FuseOSError(errno.EACCES)

    def mutation(self, path):
        operation, owner = self.context(True)
        try:
            _, request = self.store.validate(operation)
            if path.startswith(".git/"):
                if path in (".git/config", ".git/commondir", ".git/gitdir", ".git/worktrees", ".git/modules") or path.startswith((".git/hooks/", ".git/info/", ".git/objects/info/", ".git/worktrees/", ".git/modules/")):
                    raise Rejected("permission_denied")
                if not any(claim["resource"].startswith("ref:") for claim in request["claims"]):
                    raise Rejected("claim_required")
            else:
                claim = next((claim for claim in request["claims"] if claim["resource"] == "file:" + path), None)
                if claim:
                    self.store.authorize(owner, claim["resource"], claim["claim"])
                elif any(claim["resource"].startswith("ref:") for claim in request["claims"]):
                    peer = self.store.db.execute("SELECT * FROM leases WHERE resource=? AND active=1 AND expires>?",
                                                 ("file:" + path, time.time())).fetchone()
                    if peer:
                        raise Rejected("claim_conflict", [path])
                else:
                    raise Rejected("claim_required", [path])
            return operation
        except Rejected as error:
            raise FuseOSError(errno.ESTALE if error.code == "stale_context" else errno.EACCES) from None

    def getattr(self, path, fh=None):
        with self.store.lock:
            # ENOENT must not roll back the absence evidence exposed to the caller.
            with self.store.db:
                operation, _ = self.context()
                path = path.lstrip("/")
                if operation:
                    self.store.capture(operation, path)
                row = self.store.file(path, operation)
            if not row:
                raise FuseOSError(errno.ENOENT)
            revision = self.store.revision(path) + (0 if "revision" in row.keys() else 1)
            kinds = {"file": stat.S_IFREG, "directory": stat.S_IFDIR, "symlink": stat.S_IFLNK}
            return dict(st_mode=kinds[row["kind"]] | row["mode"], st_nlink=2 if row["kind"] == "directory" else 1,
                        st_size=len(row["content"] or b""), st_uid=self.owner_uid, st_gid=self.owner_uid,
                        st_mtime=revision, st_ctime=revision)

    def readdir(self, path, fh):
        with self.store.lock, self.store.db:
            operation, _ = self.context()
            parent = path.lstrip("/")
            if operation:
                self.store.capture(operation, parent)
            candidates = {row[0] for row in self.store.db.execute("SELECT path FROM files")}
            if operation:
                candidates.update(row[0] for row in self.store.db.execute("SELECT path FROM staging WHERE operation=?", (operation,)))
            return [".", ".."] + [posixpath.basename(child) for child in sorted(candidates)
                                    if child and posixpath.dirname(child) == parent and self.store.file(child, operation)]

    def open(self, path, flags):
        with self.store.lock:
            with self.store.db:
                path = path.lstrip("/")
                operation, _ = self.context()
                row = self.store.file(path, operation)
                if operation:
                    self.store.capture(operation, path)
            if not row:
                raise FuseOSError(errno.ENOENT)
            return self.open_existing(path, flags, operation, row)

    def open_existing(self, path, flags, operation, row):
        # Called with the filesystem lock held; failed mutations roll back staging.
        with self.store.db:
            if flags & (os.O_ACCMODE | os.O_TRUNC):
                operation = self.mutation(path)
            if operation:
                self.store.capture(operation, path)
            if flags & os.O_TRUNC:
                self.store.stage(operation, path, "file", b"", row["mode"])
            self.next_handle += 1
            self.handles[self.next_handle] = {"path": path, "operation": operation, "append": bool(flags & os.O_APPEND)}
            return self.next_handle

    def create(self, path, mode, fi=None):
        with self.store.lock, self.store.db:
            path = path.lstrip("/")
            operation = self.mutation(path)
            if self.store.file(path, operation):
                raise FuseOSError(errno.EEXIST)
            self.store.stage(operation, path, "file", b"", mode & 0o777)
            return self.open("/" + path, os.O_WRONLY)

    def read(self, path, size, offset, fh):
        with self.store.lock, self.store.db:
            operation, _ = self.context()
            handle = self.handles[fh]
            if handle["operation"] != operation:
                raise FuseOSError(errno.EACCES)
            row = self.store.file(handle["path"], operation)
            if operation:
                self.store.capture(operation, handle["path"])
            return row["content"][offset:offset + size]

    def write(self, path, data, offset, fh):
        with self.store.lock, self.store.db:
            handle = self.handles[fh]
            path = handle["path"]
            operation = self.mutation(path)
            if handle["operation"] != operation:
                raise FuseOSError(errno.EACCES)
            row = self.store.file(path, operation)
            content = row["content"]
            if handle["append"]:
                offset = len(content)
            if offset < 0 or offset + len(data) > 16 * 1024 * 1024:
                raise FuseOSError(errno.EFBIG)
            self.store.stage(operation, path, "file", content[:offset].ljust(offset, b"\0") + data
                             + content[offset + len(data):], row["mode"])
            return len(data)

    def truncate(self, path, length, fh=None):
        with self.store.lock, self.store.db:
            path = self.handles[fh]["path"] if fh is not None else path.lstrip("/")
            operation = self.mutation(path)
            if fh is not None and self.handles[fh]["operation"] != operation:
                raise FuseOSError(errno.EACCES)
            row = self.store.file(path, operation)
            if length < 0 or length > 16 * 1024 * 1024:
                raise FuseOSError(errno.EFBIG)
            self.store.stage(operation, path, "file", row["content"][:length].ljust(length, b"\0"), row["mode"])

    def rename(self, old, new):
        with self.store.lock, self.store.db:
            old, new = old.lstrip("/"), new.lstrip("/")
            operation = self.mutation(old)
            self.mutation(new)
            row = self.store.file(old, operation)
            if not row:
                raise FuseOSError(errno.ENOENT)
            if row["kind"] == "directory":
                raise FuseOSError(errno.ENOTSUP)
            if old == new:
                return
            self.store.stage(operation, new, row["kind"], row["content"], row["mode"])
            self.store.stage(operation, old, "deleted", None, 0)
            for handle in self.handles.values():
                if handle["operation"] == operation and handle["path"] == old:
                    handle["path"] = new

    def unlink(self, path):
        with self.store.lock, self.store.db:
            path = path.lstrip("/")
            operation = self.mutation(path)
            row = self.store.file(path, operation)
            if not row:
                raise FuseOSError(errno.ENOENT)
            if row["kind"] == "directory":
                raise FuseOSError(errno.EISDIR)
            self.store.stage(operation, path, "deleted", None, 0)

    def mkdir(self, path, mode):
        with self.store.lock, self.store.db:
            path = path.lstrip("/")
            operation = self.mutation(path)
            if self.store.file(path, operation):
                raise FuseOSError(errno.EEXIST)
            self.store.stage(operation, path, "directory", None, mode & 0o777)

    def chmod(self, path, mode):
        with self.store.lock, self.store.db:
            path = path.lstrip("/")
            operation = self.mutation(path)
            row = self.store.file(path, operation)
            self.store.stage(operation, path, row["kind"], row["content"], mode & 0o777)

    def rmdir(self, path):
        with self.store.lock, self.store.db:
            path = path.lstrip("/")
            operation = self.mutation(path)
            row = self.store.file(path, operation)
            if not row:
                raise FuseOSError(errno.ENOENT)
            if row["kind"] != "directory":
                raise FuseOSError(errno.ENOTDIR)
            children = {child[0] for child in self.store.db.execute("SELECT path FROM files")}
            children.update(child[0] for child in self.store.db.execute("SELECT path FROM staging WHERE operation=?", (operation,)))
            if any(posixpath.dirname(child) == path and self.store.file(child, operation) for child in children):
                raise FuseOSError(errno.ENOTEMPTY)
            self.store.capture(operation, path)
            self.store.stage(operation, path, "deleted", None, 0)

    def readlink(self, path):
        with self.store.lock, self.store.db:
            operation, _ = self.context()
            path = path.lstrip("/")
            if operation:
                self.store.capture(operation, path)
            return self.store.file(path, operation)["content"].decode()

    def flush(self, path, fh):
        return 0

    def fsync(self, path, datasync, fh):
        # Staging is already durable. Publication happens when the operation completes.
        return 0

    def release(self, path, fh):
        with self.store.lock:
            self.handles.pop(fh, None)
