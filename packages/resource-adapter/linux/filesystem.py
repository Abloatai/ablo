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
    def __init__(self, store, workers, operation=None, project_files=None):
        self.project_files = project_files
        self.store, self.workers = store, workers
        self.operation = operation["id"] if operation else None
        self.owner_uid = operation["uid"] if operation else 0
        self.handles, self.next_handle = {}, 0
        self.released_paths = set()

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
                elif path != ".git" and self.project_files and self.project_files():
                    # Only private staging; the trusted supervisor claims every net path before publication.
                    self.store.capture(operation, path)
                elif any(claim["resource"].startswith("ref:") for claim in request["claims"]):
                    peer = self.store.db.execute("SELECT * FROM leases WHERE resource=? AND active=1 AND expires>?",
                                                 ("file:" + path, time.time())).fetchone()
                    if peer:
                        raise Rejected("claim_conflict", [path])
                elif (request.get("action") == "run" and path != ".git"
                      and not self.store.file(path)
                      and any(claim["resource"].startswith("file:") for claim in request["claims"])):
                    # New private paths may be scratch; surviving changes are guarded at publication.
                    self.store.capture(operation, path)
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
                row = self.store.metadata(path, operation)
            if not row:
                raise FuseOSError(errno.ENOENT)
            kinds = {"file": stat.S_IFREG, "directory": stat.S_IFDIR, "symlink": stat.S_IFLNK}
            return dict(st_mode=kinds[row["kind"]] | row["mode"], st_nlink=2 if row["kind"] == "directory" else 1,
                        st_size=row["size"] or 0, st_uid=self.owner_uid, st_gid=self.owner_uid,
                        st_mtime=row["mtime"], st_ctime=row["mtime"])

    def readdir(self, path, fh):
        with self.store.lock, self.store.db:
            operation, _ = self.context()
            parent = path.lstrip("/")
            if operation:
                self.store.capture(operation, parent)
            # Supply d_type so name/type scans do not fall back to statting every file.
            # Kind changes already advance the parent membership revision.
            kinds = {"file": stat.S_IFREG, "directory": stat.S_IFDIR, "symlink": stat.S_IFLNK}
            return [".", ".."] + [(posixpath.basename(child),
                                   {"st_mode": kinds[self.store.metadata(child, operation)["kind"]]}, 0)
                                  for child in self.store.children(parent, operation)]

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
            if old == new:
                return
            if new.startswith(old + "/"):
                raise FuseOSError(errno.EINVAL)
            target = self.store.file(new, operation)
            if target:
                if (row["kind"] == "directory") != (target["kind"] == "directory"):
                    raise FuseOSError(errno.ENOTDIR if row["kind"] == "directory" else errno.EISDIR)
                if target["kind"] == "directory":
                    self.store.capture(operation, new)
                    if self.store.children(new, operation):
                        raise FuseOSError(errno.ENOTEMPTY)
            paths = [old]
            for path in paths:
                self.mutation(path)
                self.mutation(new + path[len(old):])
                self.store.capture(operation, path)
                if self.store.file(path, operation)["kind"] == "directory":
                    paths.extend(self.store.children(path, operation))
            # Validate every descendant before staging the move; final publication still checks its net diff.
            for path in paths:
                entry = self.store.file(path, operation)
                self.store.stage(operation, new + path[len(old):], entry["kind"], entry["content"], entry["mode"])
                self.store.stage(operation, path, "deleted", None, 0)
            for handle in self.handles.values():
                if handle["operation"] == operation and (handle["path"] == old or handle["path"].startswith(old + "/")):
                    handle["path"] = new + handle["path"][len(old):]

    def unlink(self, path):
        with self.store.lock, self.store.db:
            path = path.lstrip("/")
            # libfuse removes open-unlinked placeholders as root after releasing the handle.
            if (self.operation and fuse_get_context()[0] == 0 and path in self.released_paths
                    and not self.store.file(path)):
                operation = self.operation
                self.store.validate(operation)
            else:
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

    def chown(self, path, uid, gid):
        with self.store.lock, self.store.db:
            # Ownership is fixed by the admitted operation; the gofer repeats it after create.
            if uid not in (-1, 2**32 - 1, self.owner_uid) or gid not in (-1, 2**32 - 1, self.owner_uid):
                raise FuseOSError(errno.EPERM)
            path = path.lstrip("/")
            operation = self.mutation(path)
            self.store.capture(operation, path)
            if not self.store.file(path, operation):
                raise FuseOSError(errno.ENOENT)
            return 0

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
            if self.store.children(path, operation):
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
            handle = self.handles.pop(fh, None)
            if handle and handle["operation"] == self.operation:
                self.released_paths.add(handle["path"])
