"""Exact publication witnesses guard optimistic project-authorized native staging."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
from store import Store, Rejected
from publication import publish_project


class ProjectPublication(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        seed = self.root / 'seed'
        seed.mkdir()
        (seed / 'source').write_text('BASE')
        (seed / 'other').write_text('OTHER')
        self.store = Store(str(self.root / 'state'), 'workspace', str(seed), str(self.root / 'identities'))
        self.request = {'action': 'run', 'operationId': str(uuid.uuid4()), 'claims': [], 'reads': [], 'argv': ['native']}
        with self.store.lock, self.store.db:
            self.operation, _ = self.store.start('writer', self.request)
            self.store.pin(self.operation['id'])
        self.held, self.released, self.calls = {}, [], []
        self.fence = 0
        self.authorized = True
        self.before_grant = lambda resource: None
        self.adapter = SimpleNamespace(store=self.store, authorize_project=self.authorize, project_valid=self.authorize,
                                       upstream=self.upstream, execute=self.execute)

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def authorize(self, owner, operation):
        self.assertEqual(operation, self.operation["id"])
        self.assertFalse(self.store.db.in_transaction)
        if not self.authorized:
            raise Rejected('permission_denied')
        return True

    def upstream(self, owner, action, resource, ttl):
        self.assertFalse(self.store.db.in_transaction)
        self.assertEqual(action, 'claim')
        self.before_grant(resource)
        self.calls.append(resource)
        self.fence += 1
        grant = {'claim': str(uuid.uuid4()), 'fence': self.fence, 'expires': time.time() + 30}
        self.held[resource] = grant
        return grant

    def execute(self, owner, request):
        self.assertFalse(self.store.db.in_transaction)
        resource = request['resource']
        if request['action'] == 'heartbeat':
            if resource not in self.held:
                raise Rejected('claim_lost')
        elif request['action'] == 'release':
            self.released.append(resource)
            self.held.pop(resource, None)
            with self.store.lock, self.store.db:
                self.store.db.execute('UPDATE leases SET active=0 WHERE resource=? AND claim=?', (resource, request['claim']))

    def stage(self, path, kind='file', content=b'NEW'):
        with self.store.lock, self.store.db:
            self.store.stage(self.operation['id'], path, kind, content, 0o644)

    def publish(self):
        return publish_project(self.adapter, 'writer', self.operation['id'], self.request, {})

    def test_exact_crud_and_immutable_intent(self):
        self.stage('source')
        self.stage('new')
        self.stage('other', 'deleted', None)
        receipt = self.publish()
        self.assertEqual(receipt['status'], 'applied')
        self.assertEqual(self.calls, ['file:new', 'file:other', 'file:source'])
        self.assertEqual(self.released, self.calls)
        self.assertEqual(receipt['publication']['paths'], ['new', 'other', 'source'])
        with self.store.lock:
            same, fresh = self.store.start('writer', self.request)
            self.assertFalse(fresh)
            self.assertEqual(json.loads(same['receipt']), receipt)
            self.assertEqual(json.loads(same['intent']), self.request)
        self.assertEqual(self.store.file('source')['content'], b'NEW')
        self.assertIsNone(self.store.file('other'))

    def test_conflict_releases_partial_set_and_never_publishes(self):
        self.stage('new'); self.stage('source')
        def conflict(resource):
            if resource == 'file:source':
                raise Rejected('claim_conflict')
        self.before_grant = conflict
        with self.assertRaisesRegex(Rejected, 'claim_conflict'):
            self.publish()
        self.assertEqual(self.store.file('source')['content'], b'BASE')
        self.assertIsNone(self.store.file('new'))
        self.assertEqual(self.released, ['file:new'])

    def test_implicit_base_capture_rejects_peer_write_during_acquisition(self):
        self.stage('source')
        def race(resource):
            with self.store.lock, self.store.db:
                self.store.db.execute("UPDATE files SET content=?,revision=revision+1 WHERE path='source'", (b'PEER',))
        self.before_grant = race
        with self.assertRaisesRegex(Rejected, 'stale_context'):
            self.publish()
        self.assertEqual(self.store.file('source')['content'], b'PEER')
        self.assertEqual(self.released, ['file:source'])

    def test_absence_and_membership_captured_without_explicit_read(self):
        self.stage('new')
        with self.store.lock, self.store.db:
            self.store.db.execute("UPDATE files SET revision=revision+1 WHERE path=''")
        with self.assertRaisesRegex(Rejected, 'stale_context'):
            self.publish()
        self.assertFalse(self.calls)
        self.assertIsNone(self.store.file('new'))

    def test_final_revocation_rejects_and_releases(self):
        self.stage('source')
        self.before_grant = lambda resource: setattr(self, 'authorized', False)
        with self.assertRaisesRegex(Rejected, 'permission_denied'):
            self.publish()
        self.assertEqual(self.store.file('source')['content'], b'BASE')
        self.assertEqual(self.released, ['file:source'])

    def test_unknown_grant_reply_journals_request_and_never_claims_success(self):
        self.stage('source')
        def unknown(resource):
            raise OSError('reply lost')
        self.before_grant = unknown
        with self.assertRaises(OSError):
            self.publish()
        row = self.store.db.execute('SELECT * FROM operations WHERE id=?', (self.operation['id'],)).fetchone()
        witness = json.loads(row['publication'])
        self.assertEqual(witness['requests'], [{'operationId': self.operation['id'], 'resource': 'file:source'}])
        self.assertEqual(witness['claims'], [])
        self.assertEqual(row['status'], 'running')
        self.assertEqual(self.store.file('source')['content'], b'BASE')

    def test_private_net_diff_cannot_change_after_freeze(self):
        self.stage('source')
        def tamper(resource):
            self.stage('new')
        self.before_grant = tamper
        with self.assertRaisesRegex(Rejected, 'stale_context'):
            self.publish()
        self.assertIsNone(self.store.file('new'))
        self.assertEqual(self.store.file('source')['content'], b'BASE')

    def test_static_run_cannot_use_dynamic_staging_as_publication_permission(self):
        self.stage('source')
        with self.store.lock, self.store.db:
            with self.assertRaisesRegex(Rejected, 'claim_required'):
                self.store.publish(self.operation['id'], {})

    def test_authority_deadline_cannot_be_borrowed_from_a_new_operation(self):
        import importlib.util
        from unittest.mock import patch
        binding = SimpleNamespace(FUSE=object, Operations=object, FuseOSError=OSError, fuse_get_context=lambda: (0, 0, 0))
        spec = importlib.util.spec_from_file_location('project_authority_fixture', Path(__file__).resolve().parents[1] / 'linux/daemon.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'fusepy': binding}):
            spec.loader.exec_module(module)
        adapter = module.Adapter(self.store, {1001: 'writer'}, '', '', '', project_file_uids=[1001])
        old = self.operation['id']
        new = str(uuid.uuid4())
        authorized_operation = old
        def refresh(owner, action, operationId):
            self.assertEqual(action, 'project_authorize')
            if operationId != authorized_operation:
                raise Rejected('permission_denied')
            return {'expires': time.time() + 30}
        adapter.upstream = refresh
        adapter.authorize_project('writer', old)
        authorized_operation = new
        adapter.authorize_project('writer', new)
        adapter.project_deadlines['writer', old] = time.monotonic() - 1
        self.assertTrue(adapter.project_valid('writer', new))
        with self.assertRaisesRegex(Rejected, 'permission_denied'):
            adapter.project_valid('writer', old)
        with self.assertRaisesRegex(Rejected, 'permission_denied'):
            adapter.authorize_project('writer', old)
        self.assertNotIn(('writer', old), adapter.project_deadlines)
        self.assertIn(('writer', new), adapter.project_deadlines)

    def test_gofer_self_chown_is_idempotent_and_never_transfers_ownership(self):
        import importlib.util
        import errno
        from unittest.mock import patch
        uid = self.operation['uid']
        class Denied(OSError):
            def __init__(self, code):
                super().__init__(code, 'denied')
        binding = SimpleNamespace(Operations=object, FuseOSError=Denied, fuse_get_context=lambda: (uid, uid, 1))
        spec = importlib.util.spec_from_file_location('project_chown_fixture', Path(__file__).resolve().parents[1] / 'linux/filesystem.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {'fusepy': binding}):
            spec.loader.exec_module(module)
        view = module.Filesystem(self.store, {}, self.operation, project_files=lambda: True)
        self.stage('new')
        self.assertEqual(view.chown('/new', uid, uid), 0)
        self.assertEqual(view.chown('/new', -1, 2**32 - 1), 0)
        for requested_uid, requested_gid in [(0, uid), (uid, 0), (uid + 1, uid), (uid, uid + 1)]:
            with self.assertRaises(OSError) as denied:
                view.chown('/new', requested_uid, requested_gid)
            self.assertEqual(denied.exception.errno, errno.EPERM)
        reader = module.Filesystem(self.store, {}, self.operation)
        with self.assertRaises(OSError) as denied:
            reader.chown('/source', uid, uid)
        self.assertEqual(denied.exception.errno, errno.EACCES)
        self.assertEqual(self.store.file('source')['content'], b'BASE')
        self.assertIsNone(self.store.file('new'))

    def test_project_permission_is_not_a_git_metadata_grant(self):
        self.stage('.git', 'directory', None)
        with self.assertRaisesRegex(Rejected, 'permission_denied'):
            self.publish()
        self.assertFalse(self.calls)
        self.assertIsNone(self.store.file('.git'))

    def test_witness_does_not_bypass_fence_replacement(self):
        self.stage('source')
        self.execute_original = self.adapter.execute
        def replaced(owner, request):
            self.execute_original(owner, request)
            if request['action'] == 'heartbeat':
                with self.store.lock, self.store.db:
                    self.store.db.execute('UPDATE leases SET fence=fence+1 WHERE resource=?', (request['resource'],))
        self.adapter.execute = replaced
        with self.assertRaisesRegex(Rejected, 'claim_lost'):
            self.publish()
        self.assertEqual(self.store.file('source')['content'], b'BASE')


if __name__ == '__main__':
    unittest.main()
