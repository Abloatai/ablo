"""Durable publication authority for one managed workspace."""
import base64
import hashlib
import hmac
import fcntl
from functools import lru_cache
import json
import math
import os
import posixpath
import sqlite3
import threading
import time
import uuid
from identity import Identities


class Rejected(Exception):
    def __init__(self, code, resources=()):
        self.code, self.resources = code, list(resources)
        super().__init__(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def path_name(path):
    if not isinstance(path, str) or not path or path.startswith("/") or "\0" in path:
        raise Rejected("invalid_resource")
    if any(part in ("", ".", "..") for part in path.split("/")):
        raise Rejected("invalid_resource")
    return path


class Store:
    def __init__(self, directory, workspace, seed=None, identity_directory="/var/lib/ablo-resource-adapter"):
        self.directory = directory
        os.makedirs(directory, mode=0o700, exist_ok=True)
        if os.stat(directory).st_uid != os.getuid() or os.stat(directory).st_mode & 0o077:
            raise RuntimeError("Adapter state must be owned by its supervisor with mode 0700")
        self.authority_lock = open(os.path.join(directory, "authority.lock"), "a")
        try:
            fcntl.flock(self.authority_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except Exception:
            self.authority_lock.close()
            raise
        self.identities = Identities(identity_directory)
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.deadlines = {}
        self.snapshots = {}
        self.directory_entries = lru_cache(maxsize=1024)(self.published_children)
        self.db = sqlite3.connect(os.path.join(directory, "state.sqlite"), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.executescript("""
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY,kind TEXT NOT NULL,
              content BLOB,mode INTEGER NOT NULL,revision INTEGER NOT NULL,mtime REAL NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY,content TEXT,revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS leases(resource TEXT PRIMARY KEY,owner TEXT NOT NULL,
              claim TEXT NOT NULL,fence INTEGER NOT NULL,expires REAL NOT NULL,active INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,
              uid INTEGER UNIQUE,intent TEXT NOT NULL,status TEXT NOT NULL,receipt TEXT);
            CREATE TABLE IF NOT EXISTS staging(operation TEXT NOT NULL,path TEXT NOT NULL,
              kind TEXT NOT NULL,content BLOB,mode INTEGER NOT NULL,mtime REAL NOT NULL DEFAULT 0,PRIMARY KEY(operation,path));
            CREATE TABLE IF NOT EXISTS dependencies(operation TEXT NOT NULL,path TEXT NOT NULL,
              kind TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(operation,path,kind));
            CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              path TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,owner TEXT NOT NULL,operation TEXT);
            """)
            with self.db:
                if "publication" not in {row["name"] for row in self.db.execute("PRAGMA table_info(operations)")}:
                    self.db.execute("ALTER TABLE operations ADD COLUMN publication TEXT")
                for key, value in [("workspace", workspace), ("secret", uuid.uuid4().hex)]:
                    self.db.execute("INSERT OR IGNORE INTO meta VALUES (?,?)", (key, value))
                if self.meta("workspace") != workspace:
                    raise RuntimeError("State belongs to a different workspace")
                # Old counters are not POSIX timestamps; initialize legacy state once.
                for table in ("files", "staging"):
                    if "mtime" not in {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")}:
                        self.db.execute(f"ALTER TABLE {table} ADD COLUMN mtime REAL NOT NULL DEFAULT 0")
                        self.db.execute(f"UPDATE {table} SET mtime=?", (time.time(),))
                self.identities.reserve_through(self.db.execute("SELECT MAX(uid) FROM operations").fetchone()[0])
                # A restarted supervisor must obtain fresh grants before authorizing mutation.
                self.db.execute("UPDATE leases SET active=0")
                for operation in self.db.execute("SELECT id FROM operations WHERE status='running'").fetchall():
                    self.finish(operation["id"], "aborted", {"code": "operation_interrupted"})
                if self.meta("initialized") is None:
                    self.db.execute("INSERT INTO files VALUES ('','directory',NULL,493,1,?)", (time.time(),))
                    if seed:
                        self.import_directory(seed)
                    self.db.execute("INSERT INTO meta VALUES ('initialized','1')")
        except Exception:
            self.close()
            raise

    def meta(self, key):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def import_directory(self, seed):
        for root, directories, files in os.walk(seed, followlinks=False):
            for name in directories + files:
                absolute = os.path.join(root, name)
                relative = os.path.relpath(absolute, seed)
                path_name(relative)
                info = os.lstat(absolute)
                if os.path.islink(absolute):
                    target = os.readlink(absolute)
                    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target))
                    if target.startswith("/") or resolved == ".." or resolved.startswith("../"):
                        raise Rejected("link_outside_workspace")
                    kind, content = "symlink", target.encode()
                elif os.path.isdir(absolute):
                    kind, content = "directory", None
                elif os.path.isfile(absolute) and info.st_nlink == 1:
                    if info.st_size > 16 * 1024 * 1024:
                        raise Rejected("file_too_large", [relative])
                    with open(absolute, "rb") as source:
                        kind, content = "file", source.read()
                else:
                    raise Rejected("unsupported_file_type")
                self.db.execute("INSERT INTO files VALUES (?,?,?,?,1,?)",
                                (relative, kind, content, info.st_mode & 0o777, info.st_mtime))

    def pin(self, operation):
        # The caller holds the authority lock after admission has committed.
        self.validate(operation)
        if operation in self.snapshots:
            raise Rejected("operation_already_pinned")
        snapshot = sqlite3.connect(os.path.join(self.directory, "state.sqlite"), check_same_thread=False)
        snapshot.row_factory = sqlite3.Row
        try:
            snapshot.execute("PRAGMA query_only=ON")
            snapshot.execute("BEGIN")
            snapshot.execute("SELECT value FROM meta LIMIT 1").fetchone()
        except BaseException:
            snapshot.close()
            raise
        self.snapshots[operation] = snapshot

    def source_db(self, operation=None):
        return self.snapshots.get(operation, self.db)

    def file(self, path, operation=None):
        if operation:
            row = self.db.execute("SELECT * FROM staging WHERE operation=? AND path=?", (operation, path)).fetchone()
            if row:
                return row if row["kind"] != "deleted" else None
        row = self.source_db(operation).execute("SELECT * FROM files WHERE path=?", (path,)).fetchone()
        return row if row and row["kind"] != "deleted" else None

    def metadata(self, path, operation=None):
        if operation:
            row = self.db.execute("SELECT kind,mode,length(content) AS size,mtime FROM staging WHERE operation=? AND path=?",
                                  (operation, path)).fetchone()
            if row:
                return row if row["kind"] != "deleted" else None
        row = self.source_db(operation).execute("SELECT kind,mode,length(content) AS size,revision,mtime FROM files WHERE path=?", (path,)).fetchone()
        return row if row and row["kind"] != "deleted" else None

    def published_children(self, parent, revision, operation=None):
        # Membership revisions invalidate cached names; content-only edits keep them valid.
        where = "path >= ? AND path < ?" if parent else "path != ''"
        bounds = (parent + "/", parent + "0") if parent else ()
        return tuple(row[0] for row in self.source_db(operation).execute(
            "SELECT path FROM files WHERE kind!='deleted' AND " + where, bounds)
                     if posixpath.dirname(row[0]) == parent)

    def children(self, parent, operation=None):
        candidates = set(self.published_children(parent, None, operation) if operation in self.snapshots
                         else self.directory_entries(parent, self.revision(parent)))
        if operation:
            where = "path >= ? AND path < ?" if parent else "path != ''"
            bounds = (parent + "/", parent + "0") if parent else ()
            for row in self.db.execute("SELECT path,kind FROM staging WHERE operation=? AND " + where,
                                       (operation, *bounds)):
                if posixpath.dirname(row["path"]) == parent:
                    if row["kind"] == "deleted":
                        candidates.discard(row["path"])
                    else:
                        candidates.add(row["path"])
        return sorted(candidates)

    def revision(self, path, kind="file", operation=None):
        row = self.source_db(operation).execute("SELECT revision FROM refs WHERE name=?" if kind == "ref" else "SELECT revision FROM files WHERE path=?", (path,)).fetchone()
        return row[0] if row else 0

    def capture(self, operation, path):
        self.db.execute("INSERT OR IGNORE INTO dependencies VALUES (?,?,'file',?)", (operation, path, self.revision(path, operation=operation)))

    def evidence(self, owner, path, kind="file", revision=None, unpublished=None):
        payload = {"workspace": self.meta("workspace"), "owner": owner, "path": path, "kind": kind, "revision": self.revision(path, kind) if revision is None else revision}
        if unpublished:
            payload["unpublished"] = unpublished
        data = canonical(payload).encode()
        signature = hmac.new(self.meta("secret").encode(), data, hashlib.sha256).hexdigest()
        return base64.urlsafe_b64encode(data).decode() + "." + signature

    def decode_evidence(self, owner, token):
        try:
            encoded, signature = token.split(".")
            data = base64.b64decode(encoded, altchars=b"-_", validate=True)
            expected = hmac.new(self.meta("secret").encode(), data, hashlib.sha256).hexdigest()
            payload = json.loads(data)
            if not hmac.compare_digest(signature, expected) or payload["owner"] != owner or payload["workspace"] != self.meta("workspace"):
                raise ValueError()
            return payload
        except (ValueError, KeyError, TypeError):
            raise Rejected("read_evidence_invalid") from None

    def install(self, owner, resource, grant):
        old = self.db.execute("SELECT * FROM leases WHERE resource=?", (resource,)).fetchone()
        if (not isinstance(grant.get("fence"), int) or grant["fence"] <= 0
                or not isinstance(grant.get("expires"), (int, float)) or not math.isfinite(grant["expires"]) or grant["expires"] <= time.time()):
            raise Rejected("claim_lost", [resource])
        if old and (grant["fence"] <= old["fence"]):
            if old["active"] and old["expires"] > time.time() and old["claim"] == grant["claim"] and old["owner"] == owner and old["fence"] == grant["fence"]:
                self.renew(resource, grant["expires"])
                return {"resource": resource, **grant}
            raise Rejected("fence_token_stale", [resource])
        self.db.execute("INSERT OR REPLACE INTO leases VALUES (?,?,?,?,?,1)",
                        (resource, owner, grant["claim"], grant["fence"], grant["expires"]))
        self.deadlines[resource] = time.monotonic() + max(0, grant["expires"] - time.time())
        return {"resource": resource, **grant}

    def renew(self, resource, expires):
        self.db.execute("UPDATE leases SET expires=? WHERE resource=?", (expires, resource))
        self.deadlines[resource] = time.monotonic() + max(0, expires - time.time())

    def authorize(self, owner, resource, claim=None):
        held = self.db.execute("SELECT * FROM leases WHERE resource=?", (resource,)).fetchone()
        if not held or not held["active"] or held["expires"] <= time.time() or self.deadlines.get(resource, 0) <= time.monotonic() or held["owner"] != owner or (claim and held["claim"] != claim):
            raise Rejected("claim_lost", [resource])
        return held

    def start(self, owner, request):
        operation = request.get("operationId")
        try:
            if str(uuid.UUID(operation)) != operation:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise Rejected("operation_id_invalid") from None
        intent = canonical(request)
        previous = self.db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
        if previous:
            if previous["owner"] != owner:
                raise Rejected("permission_denied")
            if previous["intent"] != intent:
                raise Rejected("idempotency_conflict")
            return previous, False
        uid = self.identities.allocate(self.meta("workspace"), owner)
        self.db.execute("INSERT INTO operations(id,owner,uid,intent,status,receipt) VALUES (?,?,?,?,'running',NULL)", (operation, owner, uid, intent))
        reads = [(read, self.decode_evidence(owner, read["evidence"])) for read in request.get("reads", [])]
        for read, payload in reads:
            if read["resource"] != payload["kind"] + ":" + payload["path"]:
                raise Rejected("read_evidence_invalid")
        for read, payload in reads:
            self.db.execute("INSERT OR IGNORE INTO dependencies VALUES (?,?,?,?)",
                            (operation, payload["path"], payload["kind"], payload["revision"]))
            existing = self.db.execute("SELECT revision FROM dependencies WHERE operation=? AND path=? AND kind=?", (operation, payload["path"], payload["kind"])).fetchone()
            if existing[0] != payload["revision"]:
                raise Rejected("read_evidence_conflict", [payload["path"]])
        unpublished = [payload["path"] for _, payload in reads if payload.get("unpublished")]
        if unpublished:
            raise Rejected("stale_context", unpublished)
        self.validate(operation)
        return self.db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone(), True

    def validate(self, operation):
        row = self.db.execute("SELECT * FROM operations WHERE id=?", (operation,)).fetchone()
        if not row or row["status"] != "running":
            raise Rejected("operation_closed")
        request = json.loads(row["intent"])
        for claim in request.get("claims", []):
            self.authorize(row["owner"], claim["resource"], claim["claim"])
        stale = [read["path"] for read in self.db.execute("SELECT * FROM dependencies WHERE operation=?", (operation,))
                 if self.revision(read["path"], read["kind"]) != read["revision"]]
        if stale:
            raise Rejected("stale_context", stale)
        return row, request

    def stage(self, operation, path, kind, content, mode):
        path_name(path)
        if kind != "deleted":
            parent = self.file(posixpath.dirname(path), operation)
            if not parent or parent["kind"] != "directory":
                raise Rejected("parent_missing", [path])
            existing = self.file(path, operation)
            if existing and (existing["kind"] == "directory") != (kind == "directory"):
                raise Rejected("unsupported_file_type", [path])
        if content is not None and len(content) > 16 * 1024 * 1024:
            raise Rejected("file_too_large", [path])
        self.capture(operation, path)
        original = self.file(path, operation)
        if original is None or original["kind"] != kind:
            self.capture(operation, posixpath.dirname(path))
        self.db.execute("INSERT OR REPLACE INTO staging VALUES (?,?,?,?,?,?)", (operation, path, kind, content, mode, time.time()))

    def finish(self, operation, status, detail):
        owner = self.db.execute("SELECT owner FROM operations WHERE id=?", (operation,)).fetchone()[0]
        # Attest the versions actually observed, never the versions current at completion.
        reads = [{"resource": row["kind"] + ":" + row["path"], "revision": row["revision"],
                  "evidence": self.evidence(owner, row["path"], row["kind"], row["revision"])}
                 for row in self.db.execute("SELECT * FROM dependencies WHERE operation=? ORDER BY kind,path", (operation,))]
        intent = json.loads(self.db.execute("SELECT intent FROM operations WHERE id=?", (operation,)).fetchone()[0])
        for read in intent.get("reads", []):
            payload = self.decode_evidence(owner, read["evidence"])
            if payload.get("unpublished"):
                for value in reads:
                    if value["resource"] == read["resource"] and value["revision"] == payload["revision"]:
                        value["evidence"] = read["evidence"]
            if not any(value["resource"] == read["resource"] and value["revision"] == payload["revision"] for value in reads):
                reads.append({"resource": read["resource"], "revision": payload["revision"], "evidence": read["evidence"]})
        if status != "applied" and self.db.execute("SELECT 1 FROM staging WHERE operation=? LIMIT 1", (operation,)).fetchone():
            # Native history may contain successful tool results for unpublished staged bytes.
            for value in reads:
                kind, path = value["resource"].split(":", 1)
                value["evidence"] = self.evidence(owner, path, kind, value["revision"], operation)
        receipt = {"operationId": operation, "status": status, **detail, "reads": reads}
        self.db.execute("UPDATE operations SET status=?,receipt=? WHERE id=?", (status, canonical(receipt), operation))
        self.db.execute("DELETE FROM staging WHERE operation=?", (operation,))
        self.db.execute("DELETE FROM dependencies WHERE operation=?", (operation,))
        self.db.execute("UPDATE profiles SET operation=NULL WHERE operation=?", (operation,))
        snapshot = self.snapshots.pop(operation, None)
        if snapshot is not None:
            snapshot.close()
        return receipt

    def changes(self, operation):
        changes = []
        for row in self.db.execute("SELECT * FROM staging WHERE operation=?", (operation,)).fetchall():
            original = self.file(row["path"])
            if (not original and row["kind"] == "deleted") or (original and all(original[key] == row[key] for key in ("kind", "content", "mode"))):
                continue
            changes.append((row, original))
        return changes

    def freeze_publication(self, operation):
        self.validate(operation)
        changes = self.changes(operation)
        values = [{"path": row["path"], "kind": row["kind"], "mode": row["mode"],
                   "sha256": hashlib.sha256(row["content"] or b"").hexdigest()} for row, _ in changes]
        values.sort(key=lambda value: value["path"])
        premises = [dict(row) for row in self.db.execute("SELECT path,kind,revision FROM dependencies WHERE operation=? ORDER BY kind,path", (operation,))]
        return {"version": 1, "digest": hashlib.sha256(canonical({"changes": values, "premises": premises}).encode()).hexdigest(),
                "premises": premises,
                "paths": [value["path"] for value in values], "claims": []}

    def publish(self, operation, detail, refs=None, publication=None):
        row, request = self.validate(operation)
        changes = self.changes(operation)
        if publication is not None:
            current = self.freeze_publication(operation)
            recorded = json.loads(row["publication"] or "null")
            if (not recorded or recorded != publication or current["digest"] != publication["digest"]
                    or current["paths"] != publication["paths"]):
                raise Rejected("stale_context")
            exact = {claim["resource"]: claim for claim in publication["claims"]}
            if set(exact) != {"file:" + path for path in current["paths"]}:
                raise Rejected("claim_required", current["paths"])
            for resource, claim in exact.items():
                held = self.authorize(row["owner"], resource, claim["claim"])
                if held["fence"] != claim["fence"]:
                    raise Rejected("claim_lost", [resource])
            detail = {**detail, "publication": publication}
        # Check the entire net diff before writing any published bytes or events.
        if publication is None and request.get("action") == "run" and not any(claim["resource"].startswith("ref:") for claim in request["claims"]):
            claimed = {claim["resource"] for claim in request["claims"]}
            unclaimed = [row["path"] for row, _ in changes if "file:" + row["path"] not in claimed]
            if unclaimed:
                raise Rejected("claim_required", unclaimed)
        paths, membership = [], set()
        for row, original in changes:
            if original is None or original["kind"] != row["kind"]:
                membership.add(posixpath.dirname(row["path"]))
            path, revision = row["path"], self.revision(row["path"]) + 1
            self.db.execute("INSERT OR REPLACE INTO files VALUES (?,?,?,?,?,?)", (path, row["kind"], row["content"], row["mode"], revision, time.time()))
            self.db.execute("INSERT INTO events(path,revision,operation) VALUES (?,?,?)", (path, revision, operation))
            paths.append(path)
        # Directory dependencies guard membership, not unrelated child content.
        for parent in membership:
            self.db.execute("UPDATE files SET revision=revision+1,mtime=? WHERE path=? AND kind='directory'", (time.time(), parent))
            if self.file(parent):
                self.db.execute("INSERT INTO events(path,revision,operation) VALUES (?,?,?)", (parent, self.revision(parent), operation))
        for name, content in (refs or {}).items():
            revision = self.revision(name, "ref") + 1
            self.db.execute("INSERT OR REPLACE INTO refs VALUES (?,?,?)", (name, content, revision))
            self.db.execute("INSERT INTO events(path,revision,operation) VALUES (?,?,?)", ("ref:" + name, revision, operation))
        return self.finish(operation, "applied", {"resources": paths, **detail})

    def close(self):
        for snapshot in self.snapshots.values():
            snapshot.close()
        self.snapshots.clear()
        self.directory_entries.cache_clear()
        self.db.close()
        self.identities.db.close()
        self.authority_lock.close()
