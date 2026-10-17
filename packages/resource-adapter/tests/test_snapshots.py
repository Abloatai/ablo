"""Native source views stay fixed; publication validates against current source."""
import unittest
import uuid
from test_store import Publication
from store import Rejected


class Snapshots(unittest.TestCase):
    setUp = Publication.setUp
    tearDown = Publication.tearDown
    request = Publication.request
    publish = Publication.publish

    def begin(self):
        with self.store.db:
            operation, _ = self.store.start('reader', {'action': 'run', 'operationId': str(uuid.uuid4()), 'claims': [], 'reads': []})
        self.store.pin(operation['id'])
        return operation['id']

    def test_repeated_and_first_reads_use_pinned_bytes_and_modes(self):
        op = self.begin()
        self.assertEqual(self.store.file('source', op)['content'], b'BASE')
        self.publish(self.request('NEW'))
        self.assertEqual(self.store.file('source', op)['content'], b'BASE')
        self.assertEqual(self.store.metadata('source', op)['revision'], 1)
        with self.store.db:
            self.store.capture(op, 'source')
        self.assertEqual(self.store.db.execute('SELECT revision FROM dependencies WHERE operation=?', (op,)).fetchone()[0], 1)
        with self.assertRaisesRegex(Rejected, 'stale_context'):
            self.store.publish(op, {})
        with self.store.db:
            self.store.finish(op, 'rejected', {'code': 'stale_context'})
        self.assertNotIn(op, self.store.snapshots)
        fresh = self.begin()
        self.assertEqual(self.store.file('source', fresh)['content'], b'NEW')

    def test_unread_old_path_and_absence_survive_peer_topology_changes(self):
        op = self.begin()
        with self.store.db:
            self.store.db.execute("UPDATE files SET kind='deleted',revision=revision+1 WHERE path='source'")
            self.store.db.execute("INSERT INTO files(path,kind,content,mode,revision) VALUES ('new','file',?,448,1)", (b'NEW',))
            self.store.db.execute("UPDATE files SET revision=revision+1 WHERE path=''")
        self.assertEqual(self.store.children('', op), ['source'])
        self.assertEqual(self.store.file('source', op)['content'], b'BASE')
        self.assertIsNone(self.store.file('new', op))
        self.assertIsNone(self.store.metadata('new', op))
        with self.store.db:
            self.store.capture(op, 'new')
        with self.assertRaisesRegex(Rejected, 'stale_context'):
            self.store.validate(op)

    def test_private_overlay_wins_over_snapshot_and_disappears_on_abort(self):
        op = self.begin()
        with self.store.db:
            self.store.stage(op, 'source', 'file', b'PRIVATE', 0o700)
            self.store.stage(op, 'scratch', 'file', b'TEMP', 0o600)
        self.publish(self.request('PEER'))
        self.assertEqual(self.store.file('source', op)['content'], b'PRIVATE')
        self.assertEqual(self.store.metadata('source', op)['mode'], 0o700)
        self.assertEqual(self.store.children('', op), ['scratch', 'source'])
        with self.store.db:
            self.store.finish(op, 'aborted', {})
        self.assertEqual(self.store.file('source')['content'], b'PEER')
        self.assertIsNone(self.store.file('scratch'))
        self.assertEqual(self.store.snapshots, {})

    def test_unobserved_peer_changes_do_not_reject_disjoint_read(self):
        op = self.begin()
        self.publish(self.request('PEER'))
        with self.store.db:
            self.store.capture(op, 'unrelated-absent')
            self.assertEqual(self.store.publish(op, {})['status'], 'applied')
        self.assertEqual(self.store.snapshots, {})

    def test_duplicate_pin_does_not_replace_original_view(self):
        op = self.begin()
        self.publish(self.request('PEER'))
        with self.assertRaisesRegex(Rejected, 'operation_already_pinned'):
            self.store.pin(op)
        self.assertEqual(self.store.file('source', op)['content'], b'BASE')


del Publication
