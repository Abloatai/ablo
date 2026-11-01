"""Fixed SRT deny mountpoints owned by an admitted private staging operation.

Identity is a creation record at the SQLite boundary, never a FUSE inode.
All calls are made under the owning Store lock/transaction. No public delete API.
"""
from store import Rejected

SANDBOX_MASKS = "srt-root-masks-v1"
ROOT_FILES = (".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc",
              ".zprofile", ".profile", ".ripgreprc", ".mcp.json")
TARGETS = tuple((p, "file") for p in ROOT_FILES) + ((".vscode", "directory"),
          (".idea", "directory"), (".claude/commands", "directory"), (".claude/agents", "directory"))


class SandboxMasks:
    def __init__(self, store):
        self.store = store
        store.db.executescript("""
          CREATE TEMP TABLE sandbox_mask_lifecycles(operation TEXT PRIMARY KEY,profile TEXT NOT NULL,state TEXT NOT NULL,count INTEGER NOT NULL DEFAULT 0);
          CREATE TEMP TABLE sandbox_mask_owners(operation TEXT NOT NULL,path TEXT NOT NULL,kind TEXT NOT NULL,
            content BLOB,mode INTEGER NOT NULL,mtime REAL NOT NULL,dirty INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(operation,path));
        """)
        # TEMP triggers observe every mutation on this single owning connection,
        # including direct SQL, delete/recreate and restoration of identical bytes.
        for event, reference in (("INSERT", "NEW"), ("UPDATE", "NEW"), ("UPDATE", "OLD"), ("DELETE", "OLD")):
            store.db.executescript(f"""
              CREATE TEMP TRIGGER sandbox_mask_{event.lower()}_{reference.lower()} AFTER {event} ON main.staging BEGIN
                UPDATE sandbox_mask_owners SET dirty=1 WHERE operation={reference}.operation
                  AND (path={reference}.path OR instr(path,{reference}.path||'/')=1 OR instr({reference}.path,path||'/')=1)
                  AND operation IN (SELECT operation FROM sandbox_mask_lifecycles WHERE state!='cleaning');
              END;
            """)

    def prepare(self, operation, profile):
        store = self.store
        _, request = store.validate(operation)
        if request.get("sandboxMasks") != SANDBOX_MASKS or request.get("profileId") != profile:
            raise Rejected("sandbox_masks_invalid")
        if store.db.execute("SELECT 1 FROM sandbox_mask_lifecycles WHERE operation=?", (operation,)).fetchone():
            raise Rejected("sandbox_masks_invalid")
        store.db.execute("INSERT INTO sandbox_mask_lifecycles(operation,profile,state) VALUES (?,?,'preparing')", (operation, profile))
        targets = list(TARGETS)
        git = store.file(".git", operation)
        if git and git["kind"] == "symlink":
            raise Rejected("sandbox_masks_invalid")
        if git and git["kind"] == "directory":
            targets.extend(((".git/hooks", "directory"), (".git/config", "file")))
        owned = []
        for target, kind in targets:
            parts = target.split("/")
            for index in range(len(parts)):
                path = "/".join(parts[:index+1])
                if path in owned:  # already masks this entire absent subtree
                    break
                row = store.file(path, operation)
                if row:
                    if row["kind"] not in ("file", "directory"):
                        raise Rejected("sandbox_masks_invalid")
                    if row["kind"] != "directory":
                        break
                else:
                    if store.db.execute("SELECT 1 FROM staging WHERE operation=? AND path=?", (operation,path)).fetchone():
                        raise Rejected("sandbox_masks_invalid")
                    entry_kind = kind if index == len(parts)-1 else "directory"
                    store.stage(operation, path, entry_kind, b"" if entry_kind == "file" else None,
                                0o444 if entry_kind == "file" else 0o555)
                    owned.append(path)
                    break
        # Register after all exclusive creations, before any native child exists.
        for path in owned:
            row = store.file(path, operation)
            store.db.execute("INSERT INTO sandbox_mask_owners(operation,path,kind,content,mode,mtime) VALUES (?,?,?,?,?,?)",
                             (operation,path,row["kind"],row["content"],row["mode"],row["mtime"]))
        store.db.execute("UPDATE sandbox_mask_lifecycles SET state='prepared',count=? WHERE operation=?", (len(owned),operation))
        return owned

    def cleanup(self, operation, profile):
        store = self.store
        store.validate(operation)
        lifecycle = store.db.execute("SELECT * FROM sandbox_mask_lifecycles WHERE operation=?", (operation,)).fetchone()
        if not lifecycle or lifecycle["profile"] != profile or lifecycle["state"] != "prepared":
            raise Rejected("sandbox_masks_unclean")
        records = store.db.execute("SELECT * FROM sandbox_mask_owners WHERE operation=? ORDER BY length(path) DESC", (operation,)).fetchall()
        if len(records) != lifecycle["count"]:
            raise Rejected("sandbox_masks_unclean")
        # Validate the whole set before removing anything. Never infer ownership
        # from emptiness, mode, name, absence at planning time or a retained fd.
        for record in records:
            row = store.file(record["path"], operation)
            if record["dirty"] or not row or any(row[k] != record[k] for k in ("kind", "content", "mode", "mtime")):
                raise Rejected("sandbox_masks_unclean")
            if row["kind"] == "directory" and store.children(record["path"], operation):
                raise Rejected("sandbox_masks_unclean")
        store.db.execute("UPDATE sandbox_mask_lifecycles SET state='cleaning' WHERE operation=?", (operation,))
        for record in records:
            store.stage(operation, record["path"], "deleted", None, 0)
        store.db.execute("UPDATE sandbox_mask_lifecycles SET state='clean' WHERE operation=?", (operation,))

    def require_clean(self, operation, request):
        if "sandboxMasks" not in request:
            return
        row = self.store.db.execute("SELECT * FROM sandbox_mask_lifecycles WHERE operation=?", (operation,)).fetchone()
        count = self.store.db.execute("SELECT count(*) FROM sandbox_mask_owners WHERE operation=?", (operation,)).fetchone()[0]
        dirty = self.store.db.execute("SELECT 1 FROM sandbox_mask_owners WHERE operation=? AND dirty!=0", (operation,)).fetchone()
        if (request["sandboxMasks"] != SANDBOX_MASKS or not row or row["profile"] != request.get("profileId")
                or row["state"] != "clean" or row["count"] != count or dirty):
            raise Rejected("sandbox_masks_unclean")
