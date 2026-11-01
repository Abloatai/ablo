import hashlib,json,tempfile,time,unittest,uuid,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'linux'))
from store import Store,Rejected
from file_removal import execute,checked_input,CAPABILITY,FENCE

class Removal(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); root=Path(self.tmp.name); seed=root/'seed'; seed.mkdir()
        for name in ['a','b','keep']: (seed/name).write_bytes(b'')
        self.store=Store(str(root/'state'),'fixture',str(seed),str(root/'ids'))
        account=str(uuid.uuid4())
        request=dict(operationId=str(uuid.uuid4()),authority=dict(accountId=account,projectId=str(uuid.uuid4()),workspaceId='coding',authorityId=str(uuid.uuid4()),epoch='live-owner'),
                     expectedHead=dict(journalSequence=70,manifestDigest='0'*64),entries=[dict(path=p,revision=1,kind='file',mode=420,size=0,sha256=hashlib.sha256(b'').hexdigest()) for p in ['a','b']])
        self.value=dict(request=request,principal=dict(accountId=account,userId='operator'),digest=hashlib.sha256(json.dumps(request,separators=(',',':')).encode()).hexdigest())
        self.grants=[dict(resource='file:'+p,claim=str(uuid.uuid4()),fence=i+1,expires=time.time()+30) for i,p in enumerate(['a','b'])]
    def tearDown(self): self.store.close(); self.tmp.cleanup()
    def call(self,phase,**extra): return execute(self.store,0,dict(action='source_file_removal',phase=phase,input=self.value,resourceWorkspaceId='fixture',**extra),CAPABILITY)
    def prepare(self): return self.call('prepare',grants=self.grants,expiresAt=time.time()*1000+10000)
    def commit(self): return self.call('commit',grants=self.grants,expiresAt=time.time()*1000+10000)
    def test_exact_atomic_removal_records_principal_reads_and_no_native_uid(self):
        self.prepare(); self.assertIsNotNone(self.store.file('a'));self.assertIsNotNone(self.store.file('b'))
        row=self.store.db.execute('SELECT * FROM operations').fetchone();self.assertIsNone(row['uid'])
        self.assertNotIn('token',row['intent']);self.assertEqual(self.store.meta(FENCE),self.value['request']['operationId'])
        receipt=self.commit();self.assertEqual(receipt['status'],'applied');self.assertEqual(receipt['digest'],self.value['digest']);self.assertEqual(receipt['principal'],self.value['principal'])
        self.assertTrue({'file:a','file:b'} <= {r['resource'] for r in receipt['reads']})
        self.assertIsNone(self.store.file('a'));self.assertIsNone(self.store.file('b'));self.assertIsNotNone(self.store.file('keep'))
        self.assertEqual(self.call('inspect')['receipt'],receipt);self.assertEqual(self.commit(),receipt)
        self.call('release');self.assertIsNone(self.store.meta(FENCE))
    def test_changed_second_entry_preserves_every_file_and_no_partial_intent(self):
        self.store.db.execute("UPDATE files SET mode=292 WHERE path='b'");self.store.db.commit()
        with self.assertRaises(Rejected):self.prepare()
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM operations').fetchone()[0],0)
        self.assertIsNotNone(self.store.file('a'));self.assertIsNotNone(self.store.file('b'));self.assertIsNone(self.store.meta(FENCE))
    def test_replacement_between_prepare_and_commit_rejects_all(self):
        self.prepare();self.store.db.execute("UPDATE files SET revision=revision+1 WHERE path='b'");self.store.db.commit()
        with self.assertRaises(Rejected):self.commit()
        self.assertIsNotNone(self.store.file('a'));self.assertIsNotNone(self.store.file('b'))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM staging').fetchone()[0],0)
    def test_injected_second_stage_failure_rolls_back_first(self):
        self.prepare();stage=self.store.stage;calls=[]
        def fail(*args):
            calls.append(args)
            if len(calls)==2:raise Rejected('fixture_failure')
            stage(*args)
        self.store.stage=fail
        with self.assertRaises(Rejected):self.commit()
        self.assertIsNotNone(self.store.file('a'));self.assertIsNotNone(self.store.file('b'))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM staging').fetchone()[0],0)
    def test_root_only_no_worker_run_or_missing_capability(self):
        msg=dict(action='source_file_removal',phase='inspect',input=self.value,resourceWorkspaceId='fixture')
        for peer,enabled,extra in [(2001,CAPABILITY,{}),(0,None,{}),(0,CAPABILITY,dict(workerUid=1001)),(0,CAPABILITY,dict(argv=['sh']))]:
            with self.subTest(peer=peer,extra=extra),self.assertRaises(Rejected):execute(self.store,peer,{**msg,**extra},enabled)
    def test_wrong_principal_or_digest_cannot_reconcile(self):
        self.prepare();self.commit();self.value['principal']['userId']='different'
        with self.assertRaises(Rejected):self.call('inspect')
        self.value['principal']['userId']='operator';self.value['digest']='0'*64
        with self.assertRaises(Rejected):self.call('inspect')
    def test_live_operation_and_existing_profile_block_admission(self):
        with self.store.db:self.store.start('worker',dict(action='run',operationId=str(uuid.uuid4()),claims=[],reads=[]))
        with self.assertRaises(Rejected):self.prepare()
        self.assertIsNone(self.store.meta(FENCE))
    def test_prepared_fence_blocks_new_native_admission(self):
        self.prepare()
        with self.store.db,self.assertRaises(Rejected):self.store.start('worker',dict(action='run',operationId=str(uuid.uuid4()),claims=[],reads=[]))
        self.assertEqual(self.call('abort')['status'],'rejected');self.call('release')
        with self.store.db:self.store.start('worker',dict(action='run',operationId=str(uuid.uuid4()),claims=[],reads=[]))
    def test_expired_authority_and_missing_claim_cannot_commit(self):
        self.prepare()
        with self.assertRaises(Rejected):self.call('commit',grants=self.grants,expiresAt=time.time()*1000-1)
        with self.assertRaises(Rejected):self.call('commit',grants=self.grants[:1],expiresAt=time.time()*1000+10000)
        self.assertIsNotNone(self.store.file('a'));self.assertIsNotNone(self.store.file('b'))
    def test_symlink_kind_and_metadata_hash_checks(self):
        for changes in [dict(kind='symlink'),dict(mode=292),dict(content=b'x'),dict(revision=2)]:
            with self.subTest(changes=changes):
                self.store.db.execute("UPDATE files SET kind='file',mode=420,content=?,revision=1 WHERE path='a'",(b'',))
                for key,value in changes.items():self.store.db.execute('UPDATE files SET '+key+'=? WHERE path=?',(value,'a'))
                self.store.db.commit()
                with self.assertRaises(Rejected):self.prepare()
                self.assertIsNotNone(self.store.file('b'))
    def test_restart_retains_fence_and_original_rejection_without_replay(self):
        self.prepare();directory=self.store.directory;self.store.close()
        self.store=Store(directory,'fixture',identity_directory=str(Path(self.tmp.name)/'ids'))
        receipt=self.call('inspect')['receipt'];self.assertEqual(receipt['status'],'aborted');self.assertEqual(receipt['digest'],self.value['digest'])
        self.assertEqual(self.commit(),receipt);self.assertIsNotNone(self.store.file('a'))

    def test_abort_before_prepare_retains_bound_rejection_without_file_changes(self):
        receipt=self.call('abort');self.assertEqual(receipt['status'],'rejected')
        self.assertEqual(receipt['digest'],self.value['digest']);self.assertEqual(receipt['principal'],self.value['principal'])
        self.assertIsNotNone(self.store.file('a'));self.assertIsNotNone(self.store.file('b'))
        self.assertIsNone(self.store.db.execute('SELECT uid FROM operations').fetchone()['uid'])
        self.assertEqual(self.call('inspect')['receipt'],receipt)
        self.call('release');self.assertIsNone(self.store.meta(FENCE))

    def test_numeric_contract_matches_shared_coding_canonical_digest(self):
        fixture=json.loads((Path(__file__).parent/'source-removal-numeric.json').read_text())
        value=dict(request=fixture['request'],principal=dict(accountId=fixture['request']['authority']['accountId'],userId='fixture'),digest=fixture['digest'])
        checked,_=checked_input(value)
        serialized=json.dumps(checked['request'],ensure_ascii=False,separators=(',',':'))
        self.assertEqual(serialized,fixture['canonical'])
        self.assertEqual(hashlib.sha256(serialized.encode()).hexdigest(),fixture['digest'])
        for revision in ['1',-1,1.5,2**53,float('nan'),float('inf'),None,True]:
            invalid=json.loads(json.dumps(value));invalid['request']['entries'][0]['revision']=revision
            with self.assertRaises(Rejected):checked_input(invalid)

if __name__=='__main__':unittest.main()
