"""Root-only exact-file maintenance; no command, UID, recursive delete or path discovery."""
import hashlib
import json
import math
import time
import uuid
from store import Rejected, canonical, path_name

CAPABILITY = 'atomic-v1'
ACTION = 'source_file_removal'
FENCE = 'source_file_removal_fence'


def checked_input(value):
    def shape(item, keys):
        if not isinstance(item, dict) or set(item) != set(keys.split()): raise Rejected('request_invalid')
    def text(value, maximum):
        if not isinstance(value, str) or not 0 < len(value) <= maximum: raise Rejected('request_invalid')
        return value
    def integer(value, maximum):
        if type(value) is not int or not 0 <= value <= maximum: raise Rejected('request_invalid')
        return value
    def identifier(value):
        if str(uuid.UUID(value)) != value: raise Rejected('request_invalid')
        return value
    def digest(value):
        if not isinstance(value,str) or len(value)!=64 or any(c not in '0123456789abcdef' for c in value): raise Rejected('request_invalid')
        return value
    shape(value,'request principal digest'); request=value['request']; principal=value['principal']
    shape(request,'operationId authority expectedHead entries'); shape(principal,'accountId userId')
    authority=request['authority']; head=request['expectedHead']
    shape(authority,'accountId projectId workspaceId authorityId epoch'); shape(head,'journalSequence manifestDigest')
    authority=dict(accountId=identifier(authority['accountId']),projectId=identifier(authority['projectId']),
                   workspaceId=text(authority['workspaceId'],128),authorityId=identifier(authority['authorityId']),epoch=text(authority['epoch'],128))
    principal=dict(accountId=identifier(principal['accountId']),userId=text(principal['userId'],256))
    if principal['accountId']!=authority['accountId']: raise Rejected('permission_denied')
    entries=request['entries']
    if not isinstance(entries,list) or not 1<=len(entries)<=128: raise Rejected('request_invalid')
    checked=[]
    for entry in entries:
        shape(entry,'path revision kind mode size sha256'); path=path_name(text(entry['path'],4096))
        if any(ord(c)<32 or ord(c)==127 or c=='\\' for c in path) or '.git' in [p.lower() for p in path.split('/')]: raise Rejected('request_invalid')
        if entry['kind']!='file': raise Rejected('request_invalid')
        checked.append(dict(path=path,revision=integer(entry['revision'],2**53-1),kind='file',mode=integer(entry['mode'],0o7777),
                            size=integer(entry['size'],2**53-1),sha256=digest(entry['sha256'])))
    if len({e['path'] for e in checked})!=len(checked): raise Rejected('request_invalid')
    checked.sort(key=lambda e:e['path'].encode('utf-16-be'))
    request=dict(operationId=identifier(request['operationId']),authority=authority,
                 expectedHead=dict(journalSequence=integer(head['journalSequence'],2**53-1),manifestDigest=digest(head['manifestDigest'])),entries=checked)
    serialized=json.dumps(request,ensure_ascii=False,separators=(',',':'))
    if hashlib.sha256(serialized.encode()).hexdigest()!=digest(value['digest']): raise Rejected('idempotency_conflict')
    owner='maintenance:'+hashlib.sha256(json.dumps([authority['authorityId'],principal['accountId'],principal['userId'],request['operationId'],value['digest']],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    return dict(request=request,principal=principal,digest=value['digest']), owner


def execute(store, peer, message, enabled):
    if peer!=0 or enabled!=CAPABILITY or any(k in message for k in ('workerUid','authority','interactive','argv')):
        raise Rejected('permission_denied')
    if set(message)-{'action','phase','input','resourceWorkspaceId','grants','expiresAt'} or message.get('action')!=ACTION:
        raise Rejected('request_invalid')
    value,owner=checked_input(message.get('input')); request=value['request']; operation=request['operationId']
    phase=message.get('phase')
    if phase not in ('inspect','prepare','commit','abort','release'): raise Rejected('request_invalid')
    if message.get('resourceWorkspaceId')!=store.meta('workspace'): raise Rejected('permission_denied')
    intent=dict(action=ACTION,**value,operationId=operation,claims=[],reads=[])
    with store.lock,store.db:
        previous=store.db.execute('SELECT * FROM operations WHERE id=?',(operation,)).fetchone()
        if previous and (previous['owner']!=owner or previous['intent']!=canonical(intent)):
            raise Rejected('idempotency_conflict')
        fence=store.meta(FENCE)
        if phase=='inspect':
            return dict(sourceFileRemoval=CAPABILITY,status=previous['status'] if previous else 'absent',
                        receipt=json.loads(previous['receipt']) if previous and previous['receipt'] else None,fenced=fence)
        if fence and fence!=operation: raise Rejected('adapter_busy')
        if phase=='release':
            if not previous or previous['status']=='running': raise Rejected('operation_closed')
            store.db.execute('DELETE FROM meta WHERE key=? AND value=?',(FENCE,operation))
            return dict(released=True)
        if phase=='abort':
            if not previous:
                store.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',(FENCE,operation))
                store.start(owner,intent,maintenance=True)
                previous=store.db.execute('SELECT * FROM operations WHERE id=?',(operation,)).fetchone()
            return json.loads(previous['receipt']) if previous['receipt'] else store.finish(operation,'rejected',dict(code='permission_denied',digest=value['digest'],principal=value['principal']))
        if previous and previous['status']!='running': return json.loads(previous['receipt'])
        # A short root-attested write lease, never journaled. Same-host clocks;
        # callers subtract a skew reserve before sending this absolute expiry.
        expiry=message.get('expiresAt')
        if not isinstance(expiry,(int,float)) or isinstance(expiry,bool) or not math.isfinite(expiry) or not 0<expiry-time.time()*1000<=60000:
            raise Rejected('permission_denied')
        deadline=time.monotonic()+(expiry/1000-time.time())
        if phase=='prepare' and previous: raise Rejected('operation_closed') # never replay admission
        if phase=='commit' and (not previous or fence!=operation): raise Rejected('operation_closed')
        if store.db.execute("SELECT 1 FROM operations WHERE status='running' AND id!=?",(operation,)).fetchone() or store.db.execute('SELECT 1 FROM profiles WHERE operation IS NOT NULL').fetchone():
            raise Rejected('adapter_busy')
        grants=message.get('grants')
        resources={'file:'+e['path'] for e in request['entries']}
        if not isinstance(grants,list) or len(grants)!=len(resources) or {g.get('resource') for g in grants if isinstance(g,dict)}!=resources:
            raise Rejected('claim_required')
        for grant in grants:
            if set(grant)!={'resource','claim','fence','expires'}: raise Rejected('claim_required')
            store.install(owner,grant['resource'],{k:v for k,v in grant.items() if k!='resource'})
        # Validate every exact file and each ancestor before any staging mutation.
        for entry in request['entries']:
            parts=entry['path'].split('/')
            for i in range(1,len(parts)):
                parent=store.file('/'.join(parts[:i]))
                if not parent or parent['kind']!='directory': raise Rejected('stale_context')
            row=store.file(entry['path'])
            if (not row or row['kind']!='file' or row['revision']!=entry['revision'] or row['mode']!=entry['mode']
                or len(row['content'])!=entry['size'] or hashlib.sha256(row['content']).hexdigest()!=entry['sha256']):
                raise Rejected('stale_context')
        if phase=='prepare':
            if store.db.execute('SELECT 1 FROM staging LIMIT 1').fetchone(): raise Rejected('adapter_busy')
            store.db.execute('INSERT OR REPLACE INTO meta VALUES (?,?)',(FENCE,operation))
            store.start(owner,intent,maintenance=True)
            for entry in request['entries']: store.capture(operation,entry['path'])
            return dict(operationId=operation,status='running')
        store.validate(operation)
        if store.db.execute('SELECT 1 FROM staging WHERE operation=?',(operation,)).fetchone(): raise Rejected('stale_context')
        for entry in request['entries']: store.stage(operation,entry['path'],'deleted',None,0)
        publication=store.freeze_publication(operation)
        publication['claims']=[dict(resource=g['resource'],claim=g['claim'],fence=g['fence']) for g in grants]
        store.db.execute('UPDATE operations SET publication=? WHERE id=?',(canonical(publication),operation))
        if time.monotonic()>=deadline: raise Rejected('permission_denied')
        return store.publish(operation,dict(digest=value['digest'],principal=value['principal']),publication=publication)
