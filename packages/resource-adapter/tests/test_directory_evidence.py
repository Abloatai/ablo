"""Directory observations guard entries; file observations guard their bytes and mode."""
import unittest
import uuid
from test_store import Publication
from store import Store, Rejected


class DirectoryEvidence(unittest.TestCase):
    set_up_store = Publication.setUp
    tearDown = Publication.tearDown

    def setUp(self):
        self.set_up_store()
        self.change([('src', 'directory', None, 0o755)] +
                    [(f'src/{i}', 'file', b'BASE', 0o644) for i in range(10)])

    def begin(self, owner, paths):
        with self.store.db:
            request = {'operationId': str(uuid.uuid4()), 'claims': [], 'reads': [
                {'resource': 'file:' + path, 'evidence': self.store.evidence(owner, path)}
                for path in paths]}
            operation, _ = self.store.start(owner, request)
        return operation['id']

    def change(self, entries):
        with self.store.db:
            operation = self.begin('writer', [])
            for entry in entries:
                self.store.stage(operation, *entry)
            return self.store.publish(operation, {})

    def test_ten_sibling_edits_keep_directory_evidence_and_all_apply(self):
        before = self.store.revision('src')
        operations = [self.begin(str(i), ['', 'src', f'src/{i}']) for i in range(10)]
        for i, operation in enumerate(operations):
            with self.store.db:
                self.store.stage(operation, f'src/{i}', 'file', str(i).encode(), 0o644)
        for operation in operations:
            with self.store.db:
                self.assertEqual(self.store.publish(operation, {})['status'], 'applied')
        self.assertEqual(self.store.revision('src'), before)
        for i in range(10):
            self.assertEqual(self.store.file(f'src/{i}')['content'], str(i).encode())

    def test_same_file_still_rejects_nine_stale_writers(self):
        operations = [self.begin(str(i), ['src', 'src/0']) for i in range(10)]
        for i, operation in enumerate(operations):
            with self.store.db:
                self.store.stage(operation, 'src/0', 'file', str(i).encode(), 0o644)
        with self.store.db:
            self.store.publish(operations[0], {})
        for operation in operations[1:]:
            with self.store.db, self.assertRaisesRegex(Rejected, 'stale_context'):
                self.store.publish(operation, {})
        self.assertEqual(self.store.file('src/0')['content'], b'0')

    def test_membership_changes_still_invalidate_directory_and_absence(self):
        scenarios = [
            [('src/new', 'file', b'NEW', 0o644)],
            [('src/0', 'deleted', None, 0)],
            [('src/1', 'deleted', None, 0), ('src/renamed', 'file', b'BASE', 0o644)],
            [('src/2', 'deleted', None, 0), ('src/2', 'directory', None, 0o755)],
        ]
        for entries in scenarios:
            with self.subTest(entries=entries):
                revision = self.store.revision('src')
                reader = self.begin('reader', ['src'])
                self.change(entries)
                self.assertEqual(self.store.revision('src'), revision + 1)
                with self.store.db, self.assertRaisesRegex(Rejected, 'stale_context'):
                    self.store.publish(reader, {})
        absent = self.begin('absent', ['src/missing'])
        self.change([('src/missing', 'file', b'NEW', 0o644)])
        with self.store.db, self.assertRaisesRegex(Rejected, 'stale_context'):
            self.store.publish(absent, {})

    def test_file_mode_and_directory_mode_keep_their_own_guards(self):
        for path, kind, content in [('src/0', 'file', b'BASE'), ('src', 'directory', None)]:
            with self.subTest(path=path):
                parent = 'src' if kind == 'file' else ''
                parent_revision = self.store.revision(parent)
                reader = self.begin('reader', [path])
                self.change([(path, kind, content, 0o700)])
                self.assertEqual(self.store.revision(parent), parent_revision)
                with self.store.db, self.assertRaisesRegex(Rejected, 'stale_context'):
                    self.store.publish(reader, {})

    def test_retained_directory_evidence_survives_restart_but_detects_later_creation(self):
        evidence = self.store.evidence('reader', 'src')
        self.change([('src/0', 'file', b'NEW', 0o644)])
        self.store.close()
        self.store = Store(self.state, 'workspace', identity_directory=self.identities)
        request = {'operationId': str(uuid.uuid4()), 'claims': [],
                   'reads': [{'resource': 'file:src', 'evidence': evidence}]}
        with self.store.db:
            op, _ = self.store.start('reader', request)
            self.store.publish(op['id'], {})
        self.change([('src/new', 'file', b'NEW', 0o644)])
        request['operationId'] = str(uuid.uuid4())
        with self.store.db, self.assertRaisesRegex(Rejected, 'stale_context'):
            self.store.start('reader', request)


del Publication
