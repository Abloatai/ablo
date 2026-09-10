import {Database} from '../../Database.js';
import {ModelRegistry} from '../../ModelRegistry.js';
import {BootstrapFetcher} from '../../sync/BootstrapFetcher.js';
import {registerTestModels} from '../../testing/index.js';

type Response = Awaited<ReturnType<BootstrapFetcher['fetchBootstrap']>>;
async function database(response: Response) {
  const registry=new ModelRegistry();
  registerTestModels(registry);
  const fetcher=new BootstrapFetcher({baseUrl:'https://example.test'});
  jest.spyOn(fetcher,'fetchBootstrap').mockResolvedValue(response);
  const host=new Database(registry,fetcher,{inMemory:true});
  await host.open({participantId:'user',participantKind:'user',organizationId:'org',projectId:'project',branchId:'branch',branchRoot:false});
  const store=host.getStore('Item');
  if(!store) throw new Error('Missing test store');
  const write=jest.spyOn(store,'put');
  const mark=jest.spyOn(host,'setModelPersisted');
  const checkpoint=jest.spyOn(host,'updateWorkspaceMetadata');
  return {host,write,mark,checkpoint,run:()=>host.bootstrapFromServer({type:'full',lastSyncId:0,modelsToLoad:[],syncGroups:[]},[])};
}

it('does not mark a model or snapshot persisted after a quota failure', async () => {
  const {write,mark,checkpoint,run}=await database({type:'full',lastSyncId:100,models:{Item:[{id:'one'},{id:'two'}]}});
  const error=new DOMException('Quota exceeded','QuotaExceededError');
  write.mockResolvedValueOnce().mockRejectedValueOnce(error);
  await expect(run()).rejects.toBe(error);
  expect(mark).not.toHaveBeenCalled();
  expect(checkpoint).not.toHaveBeenCalledWith(expect.objectContaining({lastSyncId:100}));
});

it('does not advance a partial bootstrap beyond the durable delta prefix', async () => {
  const {host,checkpoint,run}=await database({type:'partial',lastSyncId:200,deltas:[{id:100,actionType:'I',modelName:'Item',modelId:'one',data:{id:'one'},syncGroups:[],createdAt:'2026-09-10T00:00:00Z'}]});
  jest.spyOn(host,'processDeltaBatch').mockResolvedValue({results:[],persistedSyncId:0});
  await expect(run()).rejects.toThrow('Could not persist all bootstrap changes');
  expect(checkpoint).not.toHaveBeenCalled();
});

it('records the server checkpoint when every delivered delta persisted', async () => {
  const {host,checkpoint,run}=await database({type:'partial',lastSyncId:200,deltas:[{id:100,actionType:'I',modelName:'Item',modelId:'one',data:{id:'one'},syncGroups:[],createdAt:'2026-09-10T00:00:00Z'}]});
  jest.spyOn(host,'processDeltaBatch').mockResolvedValue({results:[],persistedSyncId:100});
  await run();
  expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({lastSyncId:200}));
});
