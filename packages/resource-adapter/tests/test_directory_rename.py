"""A directory move retains per-path ownership and pinned dependency checks."""
import errno
import time
import unittest
from test_scratch import Scratch
from store import Rejected


class DirectoryRename(unittest.TestCase):
    mount = Scratch.mount
    tearDown = Scratch.tearDown
    base_setup = Scratch.setUp
    base_request = Scratch.request

    def setUp(self):
        self.base_setup()
        self.paths = ['old', 'old/nested', 'old/nested/file', 'new', 'new/nested', 'new/nested/file']
        with self.store.db:
            for path, kind, content in [('old', 'directory', None), ('old/nested', 'directory', None), ('old/nested/file', 'file', b'CONTENT')]:
                self.store.db.execute('INSERT INTO files(path,kind,content,mode,revision) VALUES (?,?,?,?,1)', (path, kind, content, 0o755))
            for path in self.paths:
                self.store.install('a', 'file:' + path, {'claim': path, 'fence': 1, 'expires': time.time() + 60})

    def request(self):
        request = self.base_request()
        request['claims'] += [{'resource': 'file:' + path, 'claim': path} for path in self.paths]
        return request

    def test_moves_subtree_and_open_handle_atomically(self):
        fs, op = self.mount()
        handle = fs.open('/old/nested/file', 0)
        fs.rename('/old', '/new')
        self.assertEqual(fs.read('/old/nested/file', 100, 0, handle), b'CONTENT')
        self.assertEqual(self.store.file('old/nested/file')['content'], b'CONTENT')
        self.assertIsNone(self.store.file('new'))
        with self.store.db:
            receipt = self.store.publish(op, {})
        self.assertEqual(set(receipt['resources']), set(self.paths))
        self.assertIsNone(self.store.file('old'))
        self.assertEqual(self.store.file('new/nested/file')['content'], b'CONTENT')

    def test_missing_descendant_claim_has_no_partial_staging(self):
        self.paths.remove('old/nested/file')
        fs, op = self.mount()
        with self.assertRaises(OSError):
            fs.rename('/old', '/new')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM staging').fetchone()[0], 0)
        self.assertEqual(self.store.file('old/nested/file')['content'], b'CONTENT')

    def test_unclaimed_destination_descendant_cannot_publish(self):
        self.paths.remove('new/nested/file')
        fs, op = self.mount()
        fs.rename('/old', '/new')
        with self.assertRaisesRegex(Rejected, 'claim_required'):
            self.store.publish(op, {})
        self.assertEqual(self.store.file('old/nested/file')['content'], b'CONTENT')
        self.assertIsNone(self.store.file('new'))

    def test_replaces_empty_destination_directory(self):
        fs, op = self.mount()
        fs.mkdir('/new', 0o755)
        fs.rename('/old', '/new')
        with self.store.db:
            self.store.publish(op, {})
        self.assertEqual(self.store.file('new/nested/file')['content'], b'CONTENT')

    def test_rejects_self_descendant_and_nonempty_destination(self):
        fs, op = self.mount()
        with self.assertRaises(OSError) as error:
            fs.rename('/old', '/old/nested/moved')
        self.assertEqual(error.exception.args[0], errno.EINVAL)
        fs.mkdir('/new', 0o755)
        handle = fs.create('/new/keep', 0o644)
        fs.write('/new/keep', b'KEEP', 0, handle)
        with self.assertRaises(OSError) as error:
            fs.rename('/old', '/new')
        self.assertEqual(error.exception.args[0], errno.ENOTEMPTY)
        self.assertEqual(self.store.file('old/nested/file', op)['content'], b'CONTENT')

    def test_peer_membership_change_rejects_whole_move(self):
        fs, op = self.mount()
        fs.rename('/old', '/new')
        with self.store.db:
            self.store.db.execute("UPDATE files SET revision=revision+1 WHERE path='old'")
            self.store.db.execute("INSERT INTO files(path,kind,content,mode,revision) VALUES ('old/peer','file',?,420,1)", (b'PEER',))
        with self.assertRaisesRegex(Rejected, 'stale_context'):
            self.store.publish(op, {})
        self.assertEqual(self.store.file('old/peer')['content'], b'PEER')
        self.assertIsNone(self.store.file('new'))


del Scratch
