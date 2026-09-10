import {ObjectStore} from '../ObjectStore.js';
import {ModelRegistry} from '../../ModelRegistry.js';
import {registerTestModels} from '../../testing/index.js';

// Abort after a successful request, without request.onerror or tx.onerror.
// Real quota failures can occur at this commit boundary.
it.each(['add','put','delete','clear'] as const)('%s rejects an abort-only transaction', async method => {
  const name=`abort-${method}`;
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{
    const request=indexedDB.open(name,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('rows',{keyPath:'id'});
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
  const registry=new ModelRegistry();
  registerTestModels(registry);
  const metadata=registry.getMetadata('Item');
  if(!metadata) throw new Error('Missing test model');
  const store=new ObjectStore(db,'Item','rows',metadata);
  const transaction=db.transaction.bind(db);
  let requestErrors=0;
  jest.spyOn(db,'transaction').mockImplementation((...args)=>{
    const tx=transaction(...args);
    tx.addEventListener('error',()=>{requestErrors++;});
    // Queue a final successful request after the model operation, then abort
    // before commit. No request fails, so only onabort can settle the write.
    queueMicrotask(()=>{const probe=tx.objectStore('rows').get('probe');probe.onsuccess=()=>tx.abort();});
    return tx;
  });
  try {
    const operation=method==='clear'?store.clear():method==='delete'?store.delete('row'):store[method]({id:'row'});
    await expect(operation).rejects.toMatchObject({name:'AbortError'});
    expect(requestErrors).toBe(0);
  } finally {
    jest.restoreAllMocks();
    db.close();
    await new Promise<void>((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});
  }
});
