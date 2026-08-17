/**
 * OnDemandLoader — a network answer meets the pool by log position.
 *
 * A query response is a snapshot, unordered against the delta stream: it may
 * leave before a write and return after it. Whether a returned row may
 * overwrite the pooled copy is decided by the position each provably reflects
 * ({@link RowWatermarks}), never by the row's `updatedAt` — an application
 * field the server does not stamp and the client fabricates when a row arrives
 * without one.
 *
 * The first case is the shape of the claims journey that exposed the old
 * wall-clock rule: a peer's create landed through the delta stream without
 * timestamps, the client stamped "now" on it, the peer then updated the row,
 * and the granted claim's server-confirmed re-read was thrown away because the
 * fabricated local `updatedAt` was later than the server's.
 */

import { z } from 'zod';
import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../../ModelRegistry.js';
import { InstanceCache } from '../../InstanceCache.js';
import { Model } from '../../Model.js';
import { LoadStrategy, ModelScope } from '@abloatai/transaction/types';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { OnDemandLoader } from '../OnDemandLoader.js';
import * as queryClient from '../../query/client.js';

jest.mock('../../query/client.js', () => ({
  postQuery: jest.fn(),
}));

const postQueryMock = queryClient.postQuery as jest.MockedFunction<typeof queryClient.postQuery>;

class ItemModel extends Model {
  title: string | undefined;
  constructor(data: Partial<Model> & { title?: string } = {}) {
    super(data);
    // The base constructor seeds identity and dates only; a subclass owns its
    // own fields, and hydration assigns only keys the instance already has.
    this.title = data.title;
  }
  override getModelName(): string {
    return 'Item';
  }
}

function setup(readFloor: () => number) {
  const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
  registry.registerModel('Item', ItemModel, { loadStrategy: LoadStrategy.lazy });
  setActiveRegistry(registry);
  const pool = new InstanceCache({ maxSize: 100 }, registry);
  // The loader's local tier asks the database for a store; none means the
  // local tier is empty and every read goes to the (mocked) network.
  const database = { getStore: () => undefined };
  const loader = new OnDemandLoader({
    objectPool: pool,
    database,
    registry,
    schema: defineSchema({
      items: model({ title: z.string().optional() }, { typename: 'Item', load: 'lazy' }),
    }),
    baseUrl: 'http://sync.test/api',
    position: {
      get readFloor() {
        return readFloor();
      },
    },
  });
  return { pool, loader };
}

function seedFromDelta(pool: InstanceCache, id: string, title: string): ItemModel {
  // A row arriving through the delta stream without timestamps: the base
  // Model fabricates `updatedAt = now`, later than any server stamp.
  const model = pool.createFromData({ __typename: 'Item', id, title }) as ItemModel;
  pool.add(model, ModelScope.live);
  expect(model.updatedAt).toBeInstanceOf(Date);
  expect(pool.get(id)).toBe(model);
  return model;
}

function serverAnswers(row: Record<string, unknown>, stamp?: number): void {
  postQueryMock.mockResolvedValueOnce({
    results: [[row]],
    ...(stamp !== undefined ? { evidence: [[{ id: row.id as string, stamp }]] } : {}),
  });
}

describe('OnDemandLoader — network rows meet the pool by log position', () => {
  beforeEach(() => {
    postQueryMock.mockReset();
  });
  afterEach(() => {
    clearActiveRegistry();
  });

  it('applies a server row the pool holds no position for, even when the local updatedAt is later', async () => {
    const { pool, loader } = setup(() => 0);
    const resident = seedFromDelta(pool, 'r1', 'original title');
    const fabricated = resident.updatedAt?.getTime() ?? Date.now();

    serverAnswers({
      id: 'r1',
      title: 'updated while held',
      // The server's stamp is the insert time, before the fabricated local one.
      updatedAt: new Date(fabricated - 60_000).toISOString(),
    });
    await loader.fetch('items', { where: { id: 'r1' }, type: 'complete' });

    expect(pool.get<ItemModel>('r1')?.title).toBe('updated while held');
  });

  it('leaves a snapshot unapplied when the pool knows the row is beyond the position the read reflects', async () => {
    // The read is issued while the client's floor is 5; the pool learns
    // (from a delta or its own ack) that the row reached 10 before the answer
    // lands. The answer cannot carry position 10, so it is left as it is.
    let floor = 5;
    const { pool, loader } = setup(() => floor);
    const resident = seedFromDelta(pool, 'r2', 'newer local state');
    postQueryMock.mockImplementationOnce(() => {
      pool.watermarks.advance(resident, 10);
      floor = 10;
      return Promise.resolve({ results: [[{ id: 'r2', title: 'older snapshot' }]] });
    });

    await loader.fetch('items', { where: { id: 'r2' }, type: 'complete' });

    expect(pool.get<ItemModel>('r2')?.title).toBe('newer local state');
  });

  it('applies a snapshot whose evidence stamp reaches the row\'s known position', async () => {
    const { pool, loader } = setup(() => 5);
    const resident = seedFromDelta(pool, 'r3', 'from delta 10');
    pool.watermarks.advance(resident, 10);

    serverAnswers({ id: 'r3', title: 'server at 10' }, 10);
    await loader.fetch('items', { where: { id: 'r3' }, type: 'complete' });

    expect(pool.get<ItemModel>('r3')?.title).toBe('server at 10');
  });

  it('records the position a network row reflects on the pooled copy', async () => {
    const { pool, loader } = setup(() => 3);
    serverAnswers({ id: 'r4', title: 'fresh' }, 12);
    await loader.fetch('items', { where: { id: 'r4' }, type: 'complete' });

    const row = pool.get<ItemModel>('r4');
    expect(row).toBeDefined();
    expect(row && pool.watermarks.of(row)).toBe(12);
  });
});
