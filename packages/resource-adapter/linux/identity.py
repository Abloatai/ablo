"""One host-wide identity allocation boundary; operation UIDs are never reused."""
import os
import sqlite3
import threading


class Identities:
    def __init__(self, directory):
        os.makedirs(directory, mode=0o700, exist_ok=True)
        info = os.stat(directory)
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("Identity registry must be private to its supervisor")
        self.lock = threading.RLock()
        self.db = sqlite3.connect(os.path.join(directory, "identities.sqlite"), check_same_thread=False)
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS workers(uid INTEGER PRIMARY KEY,owner TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace TEXT NOT NULL,owner TEXT NOT NULL);
        """)

    def register(self, workers):
        with self.lock, self.db:
            for uid, owner in workers.items():
                existing = self.db.execute("SELECT owner FROM workers WHERE uid=?", (uid,)).fetchone()
                if existing and existing[0] != owner:
                    raise RuntimeError("A worker UID is already bound to another authenticated identity")
                self.db.execute("INSERT OR IGNORE INTO workers VALUES (?,?)", (uid, owner))

    def reserve_through(self, uid):
        if uid is None:
            return
        # Restored receipts retain UIDs allocated on a different host.
        with self.lock, self.db:
            updated = self.db.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='operations'", (uid - 10000,))
            if not updated.rowcount:
                self.db.execute("INSERT INTO sqlite_sequence(name,seq) VALUES ('operations',?)", (uid - 10000,))

    def allocate(self, workspace, owner):
        with self.lock, self.db:
            inserted = self.db.execute("INSERT INTO operations(workspace,owner) VALUES (?,?)", (workspace, owner))
            uid = 10000 + inserted.lastrowid
            if uid >= 2**31:
                raise RuntimeError("Operation UID range exhausted")
            return uid
