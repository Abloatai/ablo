"""Receipt evidence is an Ablo primitive, not a runner's inferred read set."""
import json
import time
import uuid
import unittest
from test_store import Publication
from store import Store, Rejected


class NativeEvidence(unittest.TestCase):
    setUp = Publication.setUp
    tearDown = Publication.tearDown
    request = Publication.request
    publish = Publication.publish
    def test_transient_staging_does_not_invalidate_published_absence_or_membership(self):
        with self.store.db:
            op, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
            self.store.stage(op["id"], "scratch", "directory", None, 0o700)
            self.store.stage(op["id"], "scratch/file", "file", b"temporary", 0o600)
            self.store.stage(op["id"], "scratch/file", "deleted", None, 0)
            self.store.stage(op["id"], "scratch", "deleted", None, 0)
            receipt = self.store.publish(op["id"], {})
        self.assertEqual(receipt["resources"], [])
        self.assertEqual(self.store.revision(""), 1)
        self.assertEqual(self.store.revision("scratch"), 0)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM events").fetchone()[0], 0)

    def test_unpublished_native_context_cannot_be_reused_even_when_canonical_version_matches(self):
        with self.store.db:
            op, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
            self.store.stage(op["id"], "source", "file", b"PRIVATE", 0o644)
            receipt = self.store.finish(op["id"], "rejected", {"code": "operation_interrupted"})
        self.assertEqual(self.store.revision("source"), 1)
        with self.store.db:
            request = self.request("BASED_ON_PRIVATE")
            request["reads"] = receipt["reads"]
            with self.assertRaisesRegex(Rejected, "stale_context"):
                self.store.start("a", request)
            repeated = self.store.finish(request["operationId"], "rejected", {"code": "stale_context"})
        self.assertEqual(repeated["reads"], receipt["reads"])
        self.assertEqual(self.store.file("source")["content"], b"BASE")
    # Reuse the fixture, not the baseline test cases.
    def native(self):
        request = {"action": "run", "operationId": str(uuid.uuid4()), "argv": ["cat", "source"], "claims": [], "reads": []}
        with self.store.db:
            operation, _ = self.store.start("a", request)
            for path in ["source", "missing", ""]:
                self.store.capture(operation["id"], path)
            receipt = self.store.publish(operation["id"], {"output": "BASE"})
        return request, receipt

    def test_native_reads_remain_stale_after_release_and_reacquire(self):
        _, receipt = self.native()
        self.publish(self.request("PEER"))
        with self.store.db:
            self.store.install("a", "file:source", {"claim": "next", "fence": 2, "expires": time.time() + 60})
        request = self.request("OLD", claim="next")
        request["reads"] = receipt["reads"]
        with self.store.db, self.assertRaisesRegex(Rejected, "stale_context"):
            self.store.start("a", request)
        self.assertEqual(self.store.file("source")["content"], b"PEER")

    def test_receipt_keeps_absence_and_directory_reads_across_restart(self):
        request, receipt = self.native()
        self.assertEqual({read["resource"] for read in receipt["reads"]}, {"file:source", "file:missing", "file:"})
        self.store.close()
        self.store = Store(self.state, "workspace", identity_directory=self.identities)
        durable = json.loads(self.store.db.execute("SELECT receipt FROM operations WHERE id=?", (request["operationId"],)).fetchone()[0])
        self.assertEqual(durable, receipt)
        with self.store.db:
            previous, fresh = self.store.start("a", request)
        self.assertFalse(fresh)
        self.assertEqual(json.loads(previous["receipt"]), receipt)

    def test_rejected_operation_does_not_attest_newer_version(self):
        with self.store.db:
            op, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
            self.store.capture(op["id"], "source")
        self.publish(self.request("NEW"))
        with self.store.db:
            receipt = self.store.finish(op["id"], "rejected", {"code": "stale_context"})
        payload = self.store.decode_evidence("a", receipt["reads"][0]["evidence"])
        self.assertEqual(payload["revision"], 1)
        self.assertEqual(self.store.revision("source"), 2)

    def test_own_publication_does_not_rebase_earlier_context(self):
        receipt = self.publish(self.request())
        self.assertEqual(receipt["reads"][0]["revision"], 1)
        with self.store.db, self.assertRaisesRegex(Rejected, "stale_context"):
            request = self.request("OLD")
            request["reads"] = receipt["reads"]
            self.store.start("a", request)

    def test_interrupted_read_evidence_is_durable_and_owner_bound(self):
        with self.store.db:
            op, _ = self.store.start("a", {"operationId": str(uuid.uuid4()), "claims": [], "reads": []})
            self.store.capture(op["id"], "source")
        self.store.close()
        self.store = Store(self.state, "workspace", identity_directory=self.identities)
        receipt = json.loads(self.store.db.execute("SELECT receipt FROM operations WHERE id=?", (op["id"],)).fetchone()[0])
        self.assertEqual(receipt["status"], "aborted")
        self.assertEqual(receipt["reads"][0]["revision"], 1)
        with self.assertRaisesRegex(Rejected, "read_evidence_invalid"):
            self.store.decode_evidence("b", receipt["reads"][0]["evidence"])

    def test_newer_evidence_cannot_silently_replace_old_context(self):
        _, receipt = self.native()
        self.publish(self.request("NEW"))
        request = self.request("OLD")
        request["reads"] += receipt["reads"]
        with self.store.db, self.assertRaisesRegex(Rejected, "read_evidence_conflict"):
            self.store.start("a", request)

del Publication
