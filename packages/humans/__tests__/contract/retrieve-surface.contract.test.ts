/**
 * @jest-environment node
 *
 * CONTRACT — the human materializer resolves typed retrieve()/list() values.
 *
 * The request/response counterpart is owned and tested by
 * `@abloatai/transaction`; this suite pins only the local reactive surface.
 */

import {
  createModelProxy,
  type ModelOperations,
} from '../../src/local/client/createModelProxy';
import type {
  OnDemandLoader,
  FetchOptions,
} from '../../src/local/sync/OnDemandLoader';
import type { WhereClause } from '../../src/local/query/types';
import type { SyncClient } from '../../src/local/SyncClient';
import { ModelRegistry } from '../../src/local/ModelRegistry';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { Model } from '../../src/local/Model';
import { LoadStrategy } from '@abloatai/transaction/types';

// ── Compile-time pins (surface.ts idiom) ────────────────────────────────────
// Invariant type-equality: true only when A and B are mutually assignable. The
// single-use `T` on each side is the mechanism — the probes are compared as
// whole function types, so `no-unnecessary-type-parameters` doesn't apply.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface ItemRow {
  id: string;
  title: string;
}

// WS surface: retrieve resolves the BARE row (or undefined) — no envelope.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WsRetrieveIsBareRow = Expect<
  Equal<
    Awaited<ReturnType<ModelOperations<ItemRow, ItemRow>['retrieve']>>,
    ItemRow | undefined
  >
>;
// The materializer surface resolves a bare T[].
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _WsListIsBareArray = Expect<
  Equal<Awaited<ReturnType<ModelOperations<ItemRow, ItemRow>['list']>>, ItemRow[]>
>;

// ── Canned rows served at the materializer hydration boundary ───────────────

const CANNED_ROWS: readonly ItemRow[] = [
  { id: 't1', title: 'hello' },
  { id: 't2', title: 'world' },
];

// ── WS proxy surface, against a stubbed hydration boundary ─────────────────
// `retrieve`/`list` on the stateful client resolve through
// `OnDemandLoader.fetch` (pool → IDB → POST /sync/query). The stub IS
// that network boundary; the pin is the PUBLIC resolved shape.

class ItemModel extends Model {
  override getModelName(): string {
    return 'Item';
  }
}

function buildWsProxy(): ModelOperations<ItemRow, ItemRow> {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registry.registerModel('Item', ItemModel, {
    loadStrategy: LoadStrategy.instant,
  });
  const pool = new ObjectPool({ maxSize: 100 }, registry);

  const toModel = (row: ItemRow): Model =>
    Object.assign(new ItemModel({ id: row.id }), { title: row.title });

  const hydrationStub = {
    fetch: <T>(
      _modelName: string,
      options?: FetchOptions<T>,
    ): Promise<Model[]> => {
      let rows: readonly ItemRow[] = CANNED_ROWS;
      // `retrieve` narrows via the tuple form `[['id', <id>]]`; honor it so
      // a miss is a genuine empty result, not a stub artifact. Only the tuple
      // (`WhereClause[]`) form is an array; the object forms never are.
      const where = options?.where;
      if (Array.isArray(where)) {
        for (const clause of where as readonly WhereClause[]) {
          if (clause[0] === 'id') {
            const wanted = clause[clause.length - 1];
            rows = rows.filter((r) => r.id === wanted);
          }
        }
      }
      if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
      return Promise.resolve(rows.map(toModel));
    },
  } as OnDemandLoader;

  return createModelProxy<ItemRow, ItemRow>(
    'items',
    'Item',
    pool,
    // retrieve/list never touch the SyncClient (same stub idiom as
    // client/__tests__/hydration-chain.test.ts).
    {} as SyncClient,
    registry,
    hydrationStub,
  );
}

// ── Runtime pins ────────────────────────────────────────────────────────────

describe('CONTRACT: retrieve/list transport parity', () => {
  describe('WebSocket proxy surface — bare row, no envelope', () => {
    it('retrieve({ id }) resolves the bare row', async () => {
      const items = buildWsProxy();
      const hit = await items.retrieve({ id: 't1' });
      expect(hit?.id).toBe('t1');
      expect(hit?.title).toBe('hello');
      // The bare row is not the private HTTP transport envelope — none of its
      // watermark/claim keys ride here.
      expect(hit).not.toHaveProperty('stamp');
      expect(hit).not.toHaveProperty('claims');
    });

    it('retrieve({ id }) resolves undefined on a miss (bare absence, no envelope)', async () => {
      const items = buildWsProxy();
      await expect(items.retrieve({ id: 'nope' })).resolves.toBeUndefined();
    });

    it('list() resolves a bare T[]', async () => {
      const items = buildWsProxy();
      const rows = await items.list();
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2']);
    });
  });
});
