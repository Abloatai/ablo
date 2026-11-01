"""Real SQLite creation records and publication gates; no FUSE/model qualification."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'linux'))
from store import Store, Rejected
from sandbox_masks import SANDBOX_MASKS, ROOT_FILES
from process import filesystem_sandbox_masks, FILESYSTEM_PROFILE_BUDGET


class Masks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name); seed = root/'seed'; seed.mkdir()
        (seed/'.bashrc').write_text('')  # Pre-existing empty config is never owned.
        (seed/'.bashrc').chmod(0o444)
        (seed/'source').write_text('BASE')
        self.store = Store(str(root/'state'), 'fixture', str(seed), str(root/'identities'))
        self.profile = str(uuid.uuid4())
        self.request = dict(action='run', operationId=str(uuid.uuid4()), profileId=self.profile,
                            sandboxMasks=SANDBOX_MASKS, claims=[{'resource':'file:source','claim':'fixture'}], reads=[])
        with self.store.lock, self.store.db:
            self.store.install('owner','file:source',{'claim':'fixture','fence':1,'expires':time.time()+60})
            operation, _ = self.store.start('owner', self.request)
            self.operation = operation['id']; self.store.pin(self.operation)

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def prepare(self):
        with self.store.lock, self.store.db:
            return self.store.sandbox_masks.prepare(self.operation, self.profile)

    def cleanup(self):
        with self.store.lock, self.store.db:
            self.store.sandbox_masks.cleanup(self.operation, self.profile)

    def publish(self):
        with self.store.lock, self.store.db:
            return self.store.publish(self.operation, {})

    def test_owned_staging_removed_and_existing_empty_config_preserved(self):
        paths = self.prepare()
        self.assertNotIn('.bashrc', paths)
        self.assertIn('.claude', paths)
        self.assertNotIn('.claude/agents', paths) # first absent parent is the deny mount
        self.assertTrue(self.store.changes(self.operation)) # not a manifest exclusion
        with self.assertRaises(Rejected): self.publish()
        self.cleanup()
        self.assertEqual(self.store.changes(self.operation), [])
        result = self.publish()
        self.assertEqual(result['status'], 'applied')
        self.assertEqual(result['resources'], [])
        self.assertEqual(self.store.file('.bashrc')['content'], b'')
        for path in paths: self.assertIsNone(self.store.file(path))

    def test_all_missing_recorded_once_and_duplicate_prepare_or_cleanup_rejects(self):
        self.prepare()
        with self.assertRaises(Rejected): self.prepare()
        self.cleanup()
        with self.assertRaises(Rejected): self.cleanup()

    def test_missing_ownership_never_publishes(self):
        with self.assertRaises(Rejected): self.publish()
        self.prepare()
        with self.store.db: self.store.db.execute('DELETE FROM sandbox_mask_owners WHERE operation=? AND path=?', (self.operation,'.profile'))
        with self.assertRaises(Rejected): self.cleanup()
        with self.assertRaises(Rejected): self.publish()
        self.assertIsNotNone(self.store.file('.zshrc', self.operation)) # validate all before deleting any

    def test_wrong_profile_and_expiry_reject(self):
        self.prepare()
        with self.assertRaises(Rejected): self.store.sandbox_masks.cleanup(self.operation, str(uuid.uuid4()))
        self.store.deadlines['file:source'] = time.monotonic()-1
        with self.assertRaises(Rejected): self.cleanup()

    def test_each_staging_mutation_invalidates_even_after_exact_restoration(self):
        self.prepare()
        saved = dict(self.store.file('.profile', self.operation))
        for sql, params in [
          ('UPDATE staging SET mode=420 WHERE operation=? AND path=?', (self.operation,'.profile')),
          ('UPDATE staging SET content=? WHERE operation=? AND path=?', (b'x',self.operation,'.profile')),
          ('UPDATE staging SET kind=?,content=? WHERE operation=? AND path=?', ('symlink',b'source',self.operation,'.profile')),
          ('DELETE FROM staging WHERE operation=? AND path=?', (self.operation,'.profile')),
          ('UPDATE staging SET path=? WHERE operation=? AND path=?', ('.other',self.operation,'.profile')),
        ]:
            with self.subTest(sql=sql):
                # Each assertion has a fresh generation; reset is trusted fixture setup only.
                self.store.db.execute('UPDATE sandbox_mask_owners SET dirty=0 WHERE operation=?', (self.operation,))
                self.store.db.execute(sql, params)
                self.store.db.execute('INSERT OR REPLACE INTO staging VALUES (?,?,?,?,?,?)',
                    tuple(saved[k] for k in ('operation','path','kind','content','mode','mtime')))
                self.store.db.commit()
                with self.assertRaises(Rejected): self.cleanup()
                with self.assertRaises(Rejected): self.publish()
                self.assertEqual(self.store.file('.profile', self.operation)['content'], b'')

    def test_changed_directory_descendant_blocks_whole_cleanup(self):
        self.prepare()
        with self.store.db: self.store.stage(self.operation, '.claude/unowned', 'file', b'', 0o444)
        with self.assertRaises(Rejected): self.cleanup()
        self.assertIsNotNone(self.store.file('.profile', self.operation))
        self.assertIsNotNone(self.store.file('.claude/unowned', self.operation))

    def test_late_mutation_after_cleanup_cannot_publish(self):
        self.prepare(); self.cleanup()
        with self.store.db: self.store.stage(self.operation, '.profile', 'file', b'', 0o444)
        with self.assertRaises(Rejected): self.publish()

    def test_preexisting_symlink_rejected_without_following_or_removing(self):
        with self.store.db: self.store.stage(self.operation, '.profile', 'symlink', b'source', 0o777)
        with self.assertRaises(Rejected): self.prepare()
        self.assertEqual(self.store.file('.profile', self.operation)['kind'], 'symlink')
        self.assertEqual(self.store.file('source', self.operation)['content'], b'BASE')

    def test_existing_directory_and_nested_configuration_preserved(self):
        with self.store.db:
            for path in ['.claude', '.claude/agents', '.git', '.git/hooks']:
                self.store.stage(self.operation, path, 'directory', None, 0o755)
            self.store.stage(self.operation, '.claude/agents/kept', 'file', b'KEEP', 0o644)
        paths=self.prepare()
        self.assertNotIn('.claude',paths); self.assertNotIn('.claude/agents',paths)
        self.assertIn('.claude/commands',paths); self.assertIn('.git/config',paths)
        self.cleanup()
        self.assertEqual(self.store.file('.claude/agents/kept',self.operation)['content'],b'KEEP')
        self.assertIsNone(self.store.file('.git/config',self.operation))

    def test_tombstone_cannot_adopt_and_remove_an_accepted_config(self):
        with self.store.db: self.store.stage(self.operation, '.bashrc', 'deleted', None, 0)
        with self.assertRaises(Rejected): self.prepare()
        self.assertEqual(self.store.file('.bashrc')['content'], b'')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM sandbox_mask_lifecycles').fetchone()[0],0)

    def test_cleanup_failure_rolls_back_all_removals_and_ack(self):
        paths = self.prepare()
        stage = self.store.stage; calls = []
        def fail_second(*args):
            calls.append(args[1])
            if len(calls)==2: raise Rejected('fixture_failure')
            return stage(*args)
        self.store.stage = fail_second
        try:
            with self.assertRaises(Rejected): self.cleanup()
        finally: self.store.stage = stage
        for path in paths: self.assertIsNotNone(self.store.file(path,self.operation))
        with self.assertRaises(Rejected): self.publish()
        self.cleanup(); self.assertEqual(self.publish()['status'],'applied')

    def test_fixed_root_dispatch_rejects_old_untrusted_and_mixed_modes(self):
        argv=['/usr/bin/python3','-I','/trusted/sftp.py','--workspace-profile-v1']
        request=dict(action='run',interactive=True,argv=argv,streamBudget=FILESYSTEM_PROFILE_BUDGET,sandboxMasks=SANDBOX_MASKS)
        self.assertEqual(filesystem_sandbox_masks(0,request,argv,SANDBOX_MASKS),SANDBOX_MASKS)
        for peer, changes, config in [(2001,{},SANDBOX_MASKS),(0,{},None),(0,{'argv':['/bin/sh']},SANDBOX_MASKS),
          (0,{'sandboxMasks':True},SANDBOX_MASKS),(0,{'streamBudget':None},SANDBOX_MASKS),(0,{'env':{}},SANDBOX_MASKS)]:
            with self.subTest(changes=changes), self.assertRaises(Rejected): filesystem_sandbox_masks(peer,{**request,**changes},argv,config)
        self.assertIsNone(filesystem_sandbox_masks(0,dict(action='run'),argv,None))


    def run_teardown(self, failure=None):
        # Real Adapter.run + Store. Kernel/process boundaries are controlled here;
        # the privileged Linux fixture is the separate actual namespace check.
        import importlib
        from types import SimpleNamespace
        from unittest.mock import patch
        binding=SimpleNamespace(FUSE=None,FuseOSError=OSError,Operations=object,fuse_get_context=None)
        with patch.dict(sys.modules, {'fusepy':binding}): module=importlib.import_module('daemon')
        self.store.snapshots.pop(self.operation).close()
        trace=[]; mounted=[True]
        class Thread:
            def __init__(self, target, **kwargs): self.mount=target.__name__=='mount_operation'
            def start(self): pass
            def join(self, **kwargs):
                if self.mount: trace.append('fuse-joined')
            def is_alive(self): return self.mount and failure=='mount-alive'
        def run(args, **kwargs):
            if args[0]=='fusermount': mounted[0]=False; trace.append('unmounted')
        def domain(uid):
            trace.append('uid-reaped')
            if failure=='uid-alive': raise Rejected('process_shutdown_failed')
        def close_profile():
            trace.append('profile-flushed')
            if failure=='profile-failed': raise Rejected('profile_corrupt')
            if failure=='revoked': self.store.deadlines['file:source']=time.monotonic()-1
        channel=SimpleNamespace(sandbox_masks=SANDBOX_MASKS,stream_budget=FILESYSTEM_PROFILE_BUDGET,
            output=lambda *args:None,input=lambda *args:None,send=lambda value:trace.append('started'),
            decision=SimpleNamespace(wait=lambda **kwargs:None,is_set=lambda:True),action='complete',failed=False)
        process=SimpleNamespace(poll=lambda:0,returncode=0,wait=lambda **kwargs:trace.append('process-reaped'),stdin=None,stdout=None,stderr=None)
        profile=SimpleNamespace(path=self.temp.name,close=close_profile)
        adapter=module.Adapter(self.store, {}, '', '/fixture/mount', 'fixture')
        operation=self.store.db.execute('SELECT * FROM operations WHERE id=?',(self.operation,)).fetchone()
        cleanup=self.store.sandbox_masks.cleanup
        def clean(*args): trace.append('cleanup'); return cleanup(*args)
        with patch.object(module.os.path,'ismount',side_effect=lambda p: p=='/fixture/mount' or mounted[0]), \
             patch.object(module.os,'chown'), patch.object(module.os,'makedirs'), patch.object(module.os,'rmdir'), \
             patch.object(module.threading,'Thread',Thread), patch.object(module,'Profile',return_value=profile), \
             patch.object(module,'await_domain_exit',side_effect=domain), patch.object(module.subprocess,'run',side_effect=run), \
             patch.object(module.subprocess,'Popen',return_value=process), patch.object(self.store.sandbox_masks,'cleanup',side_effect=clean):
            request={**self.request,'interactive':True,'argv':['fixture'],'timeoutMs':30000}
            if failure:
                with self.assertRaises(Rejected): adapter.run(operation,request,channel)
                with self.assertRaises(Rejected): self.publish()
            else:
                self.assertEqual(adapter.run(operation,request,channel),{'exitCode':0})
                self.assertEqual(trace,['started','process-reaped','uid-reaped','profile-flushed','unmounted','fuse-joined','cleanup'])
                self.assertEqual(self.publish()['status'],'applied')
        if failure!='revoked' and failure: self.assertNotIn('cleanup',trace)

    def test_cleanup_follows_source_process_profile_and_fuse_teardown(self): self.run_teardown()
    def test_live_source_uid_cannot_ack_cleanup(self): self.run_teardown('uid-alive')
    def test_live_fuse_thread_cannot_ack_cleanup(self): self.run_teardown('mount-alive')
    def test_profile_flush_failure_cannot_ack_cleanup(self): self.run_teardown('profile-failed')
    def test_revocation_during_teardown_cannot_ack_cleanup(self): self.run_teardown('revoked')


if __name__ == '__main__': unittest.main()
