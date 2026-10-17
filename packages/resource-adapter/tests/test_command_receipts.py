"""Exercise real receipt transactions with only the kernel command runner mocked."""
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from test_store import Publication
from store import Store

# These checks never mount FUSE; tests/native.ts covers the real kernel boundary.
with patch.dict(sys.modules, {'fusepy': SimpleNamespace(FUSE=None, FuseOSError=OSError, Operations=object, fuse_get_context=None)}):
    from daemon import Adapter


class CommandReceipts(unittest.TestCase):
    setUp = Publication.setUp
    tearDown = Publication.tearDown
    request = Publication.request
    publish = Publication.publish

    def test_failed_command_preserves_diagnostics_and_rolls_back_across_restart(self):
        adapter = Adapter(self.store, {}, '', '', '')
        request = {**self.request(), 'action': 'run', 'argv': ['fixture']}
        detail = {'exitCode': 7, 'output': 'stdout\nassertion failed\n'}

        def failed(operation, _request, _channel):
            self.store.stage(operation['id'], 'source', 'file', b'PARTIAL', 0o644)
            return detail

        with patch.object(adapter, 'run', side_effect=failed):
            receipt = adapter.execute('a', request)
        self.assertEqual(receipt['status'], 'rejected')
        self.assertEqual(receipt['code'], 'command_failed')
        self.assertEqual({k: receipt[k] for k in detail}, detail)
        self.assertEqual(self.store.file('source')['content'], b'BASE')
        self.assertEqual(self.store.revision('source'), 1)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM staging').fetchone()[0], 0)
        lookup = {'action': 'receipt', 'operationId': request['operationId']}
        self.assertEqual(adapter.execute('b', lookup)['status'], 'absent')
        self.store.close()
        self.store = Store(self.state, 'workspace', identity_directory=self.identities)
        self.assertEqual(Adapter(self.store, {}, '', '', '').execute('a', lookup), receipt)

    def test_stale_reads_still_take_precedence_over_command_failure(self):
        adapter = Adapter(self.store, {}, '', '', '')
        request = {**self.request(), 'action': 'run', 'argv': ['fixture']}

        def raced(operation, _request, _channel):
            self.store.stage(operation['id'], 'source', 'file', b'PARTIAL', 0o644)
            self.publish(self.request('PEER'))
            return {'exitCode': 7, 'output': 'obsolete diagnostic'}

        with patch.object(adapter, 'run', side_effect=raced):
            receipt = adapter.execute('a', request)
        self.assertEqual(receipt['code'], 'stale_context')
        self.assertNotIn('output', receipt)
        self.assertEqual(self.store.file('source')['content'], b'PEER')


del Publication
