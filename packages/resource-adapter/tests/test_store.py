import concurrent.futures
from contextlib import closing
import json
import os
from pathlib import Path
import subprocess
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "linux"))
from store import Store, Rejected


class Publication(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.seed = self.root / "seed"
        self.seed.mkdir()
        (self.seed / "source").write_text("BASE")
        self.state = str(self.root / "state")
        self.identities = str(self.root / "identities")
        self.store = Store(self.state, "workspace", str(self.seed), self.identities)
        with self.store.db:
            self.store.install("a", "file:source", {"claim": "first", "fence": 1, "expires": time.time() + 60})

    def tearDown(self):
        self.store.close()
        self.directory.cleanup()

    def request(self, content="NEW", evidence=None, owner="a", claim="first"):
        return {"action": "write", "operationId": str(uuid.uuid4()), "resource": "file:source", "content": content,
                "claims": [{"resource": "file:source", "claim": claim}],
                "reads": [{"resource": "file:source", "evidence": evidence or self.store.evidence(owner, "source")}]}

    def publish(self, request, owner="a"):
        with self.store.lock, self.store.db:
            operation, fresh = self.store.start(owner, request)
            if not fresh:
                return json.loads(operation["receipt"])
            self.store.stage(operation["id"], "source", "file", request["content"].encode(), 0o644)
            return self.store.publish(operation["id"], {})

    def test_directory_listing_bounds_subtree_and_merges_private_changes(self):
        with self.store.db:
            for path, kind in [("a%_[", "directory"), ("a%_[/kept", "file"),
                               ("a%_[/gone", "file"), ("a%_[/nested", "directory"),
                               ("a%_[/nested/child", "file"), ("a%_[0", "file")]:
                self.store.db.execute("INSERT INTO files(path,kind,content,mode,revision) VALUES (?,?,NULL,420,1)", (path, kind))
            self.store.db.executemany("INSERT INTO files(path,kind,content,mode,revision) VALUES (?,'file',NULL,420,1)",
                                     [("other/" + str(i),) for i in range(10000)])
            operation, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
            self.store.stage(operation["id"], "a%_[/gone", "deleted", None, 0)
            self.store.stage(operation["id"], "a%_[/new", "file", b"private", 0o600)
        # Unrelated tree size must not turn each nested listing into a full-table scan.
        self.store.db.set_progress_handler(lambda: 1, 1000)
        try:
            self.assertEqual(self.store.children("a%_["), ["a%_[/gone", "a%_[/kept", "a%_[/nested"])
            self.assertEqual(self.store.children("a%_[", operation["id"]),
                             ["a%_[/kept", "a%_[/nested", "a%_[/new"])
            self.assertEqual(self.store.children("missing"), [])
        finally:
            self.store.db.set_progress_handler(None, 0)
        self.assertEqual(self.store.children(""), ["a%_[", "a%_[0", "source"])
        self.store.db.set_progress_handler(lambda: 1, 1000)
        try:
            self.assertEqual(self.store.children(""), ["a%_[", "a%_[0", "source"])
        finally:
            self.store.db.set_progress_handler(None, 0)

    def test_cached_directory_membership_tracks_publish_and_private_overlays(self):
        self.assertEqual(self.store.children(""), ["source"])
        self.publish(self.request("content-only"))
        self.assertEqual(self.store.children(""), ["source"])
        with self.store.db:
            self.store.install("a", "file:new", {"claim": "new", "fence": 1, "expires": time.time() + 60})
            operation, _ = self.store.start("a", {"operationId": str(uuid.uuid4()),
                "claims": [{"resource": "file:new", "claim": "new"}], "reads": []})
            self.store.stage(operation["id"], "new", "file", b"private", 0o600)
        self.assertEqual(self.store.children("", operation["id"]), ["new", "source"])
        self.assertEqual(self.store.children(""), ["source"])
        with self.store.db:
            self.store.publish(operation["id"], {})
        self.assertEqual(self.store.children(""), ["new", "source"])
        with self.store.db:
            operation, _ = self.store.start("a", {"operationId": str(uuid.uuid4()),
                "claims": [{"resource": "file:new", "claim": "new"}], "reads": []})
            self.store.stage(operation["id"], "new", "deleted", None, 0)
        self.assertEqual(self.store.children("", operation["id"]), ["source"])
        self.assertEqual(self.store.children(""), ["new", "source"])
        with self.store.db:
            self.store.publish(operation["id"], {})
        self.assertEqual(self.store.children(""), ["source"])

    def test_metadata_matches_private_content_and_deletion_visibility(self):
        self.assertEqual(dict(self.store.metadata("source")), {"kind": "file", "mode": 420, "size": 4, "revision": 1, "mtime": (self.seed / "source").stat().st_mtime})
        self.assertIsNone(self.store.metadata("missing"))
        self.assertIsNone(self.store.metadata("")["size"])
        with self.store.db:
            operation, _ = self.store.start("a", self.request())
            self.store.stage(operation["id"], "source", "file", "å".encode(), 0o600)
        metadata = dict(self.store.metadata("source", operation["id"]))
        self.assertEqual({key: metadata[key] for key in ("kind", "mode", "size")}, {"kind": "file", "mode": 384, "size": 2})
        self.assertGreaterEqual(metadata["mtime"], (self.seed / "source").stat().st_mtime)
        self.assertEqual(self.store.metadata("source")["size"], 4)
        with self.store.db:
            self.store.stage(operation["id"], "source", "deleted", None, 0)
        self.assertIsNone(self.store.metadata("source", operation["id"]))
        self.assertEqual(self.store.metadata("source")["size"], 4)

    def test_publication_time_is_wall_clock_stable_and_separate_from_membership(self):
        parent = self.store.metadata("")["mtime"]
        started = time.time()
        receipt = self.publish(self.request("changed"))
        modified = self.store.metadata("source")["mtime"]
        self.assertGreaterEqual(modified, started)
        self.assertLessEqual(modified, time.time())
        self.assertEqual(self.store.metadata("")["mtime"], parent)
        self.assertEqual(self.store.revision("source"), 2)
        self.store.close()
        self.store = Store(self.state, "workspace", identity_directory=self.identities)
        self.assertEqual(self.store.metadata("source")["mtime"], modified)
        self.assertEqual(json.loads(self.store.db.execute("SELECT receipt FROM operations WHERE id=?", (receipt["operationId"],)).fetchone()[0]), receipt)

    def test_legacy_timestamp_migration_preserves_source_revisions_and_evidence(self):
        evidence = self.store.evidence("a", "source")
        self.store.close()
        with closing(sqlite3.connect(str(Path(self.state) / "state.sqlite"))) as old, old:
            old.execute("ALTER TABLE files DROP COLUMN mtime")
            old.execute("ALTER TABLE staging DROP COLUMN mtime")
        started = time.time()
        self.store = Store(self.state, "workspace", identity_directory=self.identities)
        self.assertEqual(self.store.file("source")["content"], b"BASE")
        self.assertEqual(self.store.revision("source"), 1)
        self.assertEqual(self.store.evidence("a", "source"), evidence)
        self.assertGreaterEqual(self.store.metadata("source")["mtime"], started)
        self.assertLessEqual(self.store.metadata("source")["mtime"], time.time())

    def test_atomic_content_revision_receipt_and_replay(self):
        request = self.request()
        result = self.publish(request)
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.store.file("source")["content"], b"NEW")
        self.assertEqual(self.store.revision("source"), 2)
        self.assertEqual(self.publish(request), result)
        request["content"] = "CHANGED"
        with self.assertRaisesRegex(Rejected, "idempotency_conflict"):
            self.publish(request)
        self.assertEqual(self.store.file("source")["content"], b"NEW")

    def test_change_and_revert_invalidates_old_read(self):
        original = self.store.evidence("a", "source")
        self.publish(self.request("CHANGED"))
        self.publish(self.request("BASE"))
        with self.assertRaisesRegex(Rejected, "stale_context"):
            self.publish(self.request("OLD", original))
        self.assertEqual(self.store.file("source")["content"], b"BASE")

    def test_foreign_and_forged_evidence_fail(self):
        for evidence in [self.store.evidence("b", "source"), self.store.evidence("a", "source") + "bad"]:
            with self.subTest(evidence=evidence), self.assertRaisesRegex(Rejected, "read_evidence_invalid"):
                self.publish(self.request(evidence=evidence))

    def test_takeover_fences_staged_work_before_publication(self):
        with self.store.lock, self.store.db:
            operation, _ = self.store.start("a", self.request())
            self.store.stage(operation["id"], "source", "file", b"STAGED", 0o644)
            self.store.install("b", "file:source", {"claim": "replacement", "fence": 2, "expires": time.time() + 60})
        with self.store.lock, self.store.db, self.assertRaisesRegex(Rejected, "claim_lost"):
            self.store.publish(operation["id"], {})
        self.assertEqual(self.store.file("source")["content"], b"BASE")

    def test_simultaneous_same_owner_writes_have_one_winner(self):
        evidence = self.store.evidence("a", "source")
        barrier = threading.Barrier(8)
        def write(index):
            barrier.wait()
            try:
                self.publish(self.request(str(index), evidence))
                return "applied"
            except Rejected as error:
                return error.code
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(write, range(8)))
        self.assertEqual(results.count("applied"), 1)
        self.assertEqual(results.count("stale_context"), 7)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM events WHERE path='source'").fetchone()[0], 1)

    def test_sixteen_disjoint_workers_keep_directory_context_after_unrelated_edit(self):
        requests = []
        with self.store.db:
            for i in range(16):
                path, owner = f"worker-{i}", f"owner-{i}"
                self.store.db.execute("INSERT INTO files(path,kind,content,mode,revision) VALUES (?, 'file', ?, 420, 1)", (path, b"BASE"))
                self.store.install(owner, "file:" + path, {"claim": path, "fence": i + 2, "expires": time.time() + 60})
                requests.append((owner, path, {
                    "operationId": str(uuid.uuid4()),
                    "claims": [{"resource": "file:" + path, "claim": path}],
                    "reads": [{"resource": "file:" + name, "evidence": self.store.evidence(owner, name)} for name in [path, ""]],
                }))
        self.publish(self.request("UNRELATED"))
        barrier = threading.Barrier(16)
        def write(item):
            owner, path, request = item
            barrier.wait()
            with self.store.lock, self.store.db:
                operation, _ = self.store.start(owner, request)
                self.store.stage(operation["id"], path, "file", b"UPDATED", 0o644)
                return self.store.publish(operation["id"], {})["status"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            self.assertEqual(list(pool.map(write, requests)), ["applied"] * 16)
        self.assertEqual(self.store.revision(""), 1)

    def test_membership_changes_still_invalidate_directory_context(self):
        for kind in ["file", "deleted"]:
            with self.subTest(kind=kind), self.store.db:
                evidence = self.store.evidence("a", "")
                operation, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
                self.store.stage(operation["id"], "new", kind, b"new" if kind == "file" else None, 0o644)
                self.store.publish(operation["id"], {})
                parent_event = self.store.db.execute("SELECT * FROM events WHERE path='' ORDER BY sequence DESC LIMIT 1").fetchone()
                self.assertEqual(parent_event["revision"], self.store.revision(""))
                self.assertEqual(parent_event["operation"], operation["id"])
                with self.assertRaisesRegex(Rejected, "stale_context"):
                    self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [],
                        "reads": [{"resource": "file:", "evidence": evidence}]})

    def test_restart_aborts_private_staging_and_revokes_old_claims(self):
        request = self.request()
        with self.store.db:
            operation, _ = self.store.start("a", request)
            self.store.stage(operation["id"], "source", "file", b"PART", 0o644)
        self.store.close()
        self.store = Store(self.state, "workspace", identity_directory=self.identities)
        self.assertEqual(self.store.file("source")["content"], b"BASE")
        receipt = json.loads(self.store.db.execute("SELECT receipt FROM operations WHERE id=?", (request["operationId"],)).fetchone()[0])
        self.assertEqual(receipt["status"], "aborted")
        with self.assertRaisesRegex(Rejected, "claim_lost"):
            self.store.authorize("a", "file:source", "first")
        with self.assertRaisesRegex(Rejected, "fence_token_stale"):
            self.store.install("a", "file:source", {"claim": "first", "fence": 1, "expires": time.time() + 60})

    def test_process_death_after_commit_preserves_receipt(self):
        self.store.close()
        operation_id = str(uuid.uuid4())
        script = '''import os,sys,time,json
sys.path.insert(0,sys.argv[1])
from store import Store
s=Store(sys.argv[2],"workspace",identity_directory=sys.argv[3])
with s.db:
 s.install("a","file:source",{"claim":"new","fence":2,"expires":time.time()+60})
 request={"operationId":sys.argv[4],"claims":[{"resource":"file:source","claim":"new"}],"reads":[]}
 operation,_=s.start("a",request)
 s.stage(operation["id"],"source","file",b"ONCE",420)
 s.publish(operation["id"],{})
os._exit(0)
'''
        result = subprocess.run([sys.executable, "-c", script, str(Path(__file__).resolve().parents[1] / "linux"), self.state, self.identities, operation_id], timeout=10)
        self.assertEqual(result.returncode, 0)
        self.store = Store(self.state, "workspace", identity_directory=self.identities)
        self.assertEqual(self.store.file("source")["content"], b"ONCE")
        receipt = json.loads(self.store.db.execute("SELECT receipt FROM operations WHERE id=?", (operation_id,)).fetchone()[0])
        self.assertEqual(receipt["status"], "applied")

    def test_global_identity_allocator_prevents_cross_workspace_collisions(self):
        another = Store(str(self.root / "another"), "another", identity_directory=self.identities)
        try:
            with self.store.db:
                first, _ = self.store.start("a", self.request())
            with another.db:
                second, _ = another.start("b", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
            self.assertNotEqual(first["uid"], second["uid"])
            self.store.identities.register({1001: "tenant-a"})
            with self.assertRaisesRegex(RuntimeError, "another authenticated identity"):
                another.identities.register({1001: "tenant-b"})
        finally:
            another.close()

    def test_restored_workspace_can_allocate_on_a_replacement_host(self):
        request = self.request()
        receipt = self.publish(request)
        previous_uid = self.store.db.execute("SELECT uid FROM operations WHERE id=?", (request["operationId"],)).fetchone()[0]
        self.store.close()
        replacement = str(self.root / "replacement-identities")
        self.store = Store(self.state, "workspace", identity_directory=replacement)
        self.assertEqual(json.loads(self.store.db.execute("SELECT receipt FROM operations WHERE id=?", (request["operationId"],)).fetchone()[0]), receipt)
        with self.store.db:
            operation, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
        self.assertGreater(operation["uid"], previous_uid)
        self.store.identities.reserve_through(previous_uid + 100)
        self.store.close()
        self.store = Store(self.state, "workspace", identity_directory=replacement)
        with self.store.db:
            operation, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
        self.assertGreater(operation["uid"], previous_uid + 100, "Reopening must not lower the host allocator")

    def test_clock_rollback_cannot_extend_an_expired_grant(self):
        from unittest.mock import patch
        with self.store.db:
            self.store.install("a", "file:source", {"claim": "short", "fence": 2, "expires": time.time() + .02})
        time.sleep(.04)
        with patch("store.time.time", return_value=1):
            with self.assertRaisesRegex(Rejected, "claim_lost"):
                self.store.authorize("a", "file:source", "short")

    def test_seed_links_cannot_point_outside_the_workspace(self):
        seed = self.root / "unsafe-seed"
        seed.mkdir()
        (seed / "escape").symlink_to("..")
        with self.assertRaisesRegex(Rejected, "link_outside_workspace"):
            Store(str(self.root / "unsafe-state"), "unsafe", str(seed), identity_directory=self.identities)

    def test_second_authority_and_other_workspace_are_rejected(self):
        with self.assertRaises(BlockingIOError):
            Store(self.state, "workspace", identity_directory=self.identities)


if __name__ == "__main__":
    unittest.main()
