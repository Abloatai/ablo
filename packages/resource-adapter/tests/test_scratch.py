"""Private atomic-save paths never bypass accepted-source claims."""
import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from test_store import Publication
from store import Rejected


class Scratch(unittest.TestCase):
    setUp = Publication.setUp
    tearDown = Publication.tearDown
    request = Publication.request

    def mount(self):
        request = self.request()
        request['action'] = 'run'
        with self.store.db:
            op, _ = self.store.start('a', request)
        self.uid = op['uid']
        binding = SimpleNamespace(Operations=object, FuseOSError=OSError,
                                  fuse_get_context=lambda: (self.uid, 0, 0))
        spec = importlib.util.spec_from_file_location('scratch_filesystem',
            Path(__file__).resolve().parents[1] / 'linux/filesystem.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'fusepy': binding}):
            spec.loader.exec_module(module)
        fs = module.Filesystem(self.store, {})
        fs.operation, fs.owner_uid = op['id'], op['uid']
        return fs, op['id']

    def test_atomic_save_publishes_only_claimed_destination(self):
        fs, op = self.mount()
        handle = fs.create('/sed-private', 0o644)
        fs.write('/sed-private', b'NEW', 0, handle)
        self.assertIsNone(self.store.file('sed-private'))
        self.assertEqual(self.store.file('source')['content'], b'BASE')
        fs.rename('/sed-private', '/source')
        fs.release('/source', handle)
        with self.store.db:
            receipt = self.store.publish(op, {})
        self.assertEqual(receipt['resources'], ['source'])
        self.assertEqual(self.store.file('source')['content'], b'NEW')
        self.assertIsNone(self.store.file('sed-private'))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM staging').fetchone()[0], 0)

    def test_supervisor_cleans_only_released_private_paths(self):
        fs, op = self.mount()
        handle = fs.open('/source', 0)
        fs.rename('/source', '/kernel-placeholder')
        replacement = fs.create('/source', 0o644)
        fs.write('/source', b'NEW', 0, replacement)
        fs.release('/kernel-placeholder', handle)
        self.uid = 0
        with self.assertRaises(OSError):
            fs.unlink('/source')
        with self.assertRaises(OSError):
            fs.unlink('/arbitrary')
        fs.unlink('/kernel-placeholder')
        with self.store.db:
            receipt = self.store.publish(op, {})
        self.assertEqual(receipt['resources'], ['source'])
        self.assertEqual(self.store.file('source')['content'], b'NEW')
        self.assertIsNone(self.store.file('kernel-placeholder'))

    def test_unclaimed_survivor_rejects_before_any_publication(self):
        fs, op = self.mount()
        handle = fs.create('/temporary', 0o644)
        fs.write('/temporary', b'NEW', 0, handle)
        fs.rename('/temporary', '/source')
        fs.create('/leftover', 0o600)
        events = self.store.db.execute('SELECT count(*) FROM events').fetchone()[0]
        with self.assertRaisesRegex(Rejected, 'claim_required'):
            self.store.publish(op, {})
        self.assertEqual(self.store.file('source')['content'], b'BASE')
        self.assertIsNone(self.store.file('leftover'))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM events').fetchone()[0], events)

    def test_existing_unclaimed_paths_and_git_remain_protected(self):
        with self.store.db:
            self.store.db.execute("INSERT INTO files(path,kind,content,mode,revision) VALUES ('other','file',?,420,1)", (b'PEER',))
        fs, op = self.mount()
        fs.create('/temporary', 0o600)
        for target in ['/other', '/.git', '/.git/config']:
            with self.subTest(target=target), self.assertRaises(OSError):
                fs.rename('/temporary', target)
        self.assertEqual(self.store.file('other')['content'], b'PEER')

    def test_disappearing_scratch_retains_absence_evidence(self):
        fs, op = self.mount()
        fs.create('/temporary', 0o600)
        fs.unlink('/temporary')
        with self.store.db:
            self.store.db.execute("INSERT INTO files(path,kind,content,mode,revision) VALUES ('temporary','file',?,420,1)", (b'PEER',))
        with self.assertRaisesRegex(Rejected, 'stale_context'):
            self.store.publish(op, {})
        self.assertEqual(self.store.file('temporary')['content'], b'PEER')

    def test_scratch_keeps_revocation_checks(self):
        fs, op = self.mount()
        fs.create('/temporary', 0o600)
        with self.store.db:
            self.store.db.execute("UPDATE leases SET active=0 WHERE resource='file:source'")
        with self.assertRaises(OSError):
            fs.unlink('/temporary')
        with self.assertRaisesRegex(Rejected, 'claim_lost'):
            self.store.publish(op, {})

    def test_failed_command_discards_scratch_and_source_changes(self):
        fs, op = self.mount()
        fs.create('/temporary', 0o600)
        fs.rename('/temporary', '/source')
        with self.store.db:
            receipt = self.store.finish(op, 'rejected', {'code': 'command_failed', 'exitCode': 1})
        self.assertEqual(receipt['exitCode'], 1)
        self.assertEqual(self.store.file('source')['content'], b'BASE')
        self.assertIsNone(self.store.file('temporary'))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM staging').fetchone()[0], 0)


del Publication
