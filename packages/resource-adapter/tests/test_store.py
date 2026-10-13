import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
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
