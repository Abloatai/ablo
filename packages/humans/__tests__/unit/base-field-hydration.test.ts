/**
 * Attribution hydration regression test.
 *
 * `id` is the only field every model carries. Tenancy and attribution are
 * ordinary application fields, so a model that reads `createdBy` declares it
 * like any other. Hydration assigns only keys that already exist as a property
 * on the instance.
 *
 * The bug this guards: the dynamic-model factory has to seed a property slot
 * for every declared field. Miss one and each inbound `createdBy` is silently
 * dropped → `collection.createdBy === undefined`. A profile page filtering
 * `collections.filter(d => d.createdBy === userId)` could then never surface a
 * person's collections.
 */

import { z } from 'zod';
import { model } from '@abloatai/transaction/schema/model';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { Ablo, type InternalAbloOptions } from '../../src/Ablo';
import { Model } from '../../src/local/Model';
import type { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';

// A model that wants to read its tenancy and author declares them itself.
interface Collection extends Model {
  title: string;
  organizationId?: string;
  createdBy?: string;
}

const schema = defineSchema({
  collections: model({
    title: z.string(),
    organizationId: z.string().optional(),
    createdBy: z.string().optional(),
  }),
});

function createEngine() {
  const opts: InternalAbloOptions<typeof schema.models> = {
    baseURL: 'ws://localhost:8080',
    schema,
    organizationId: 'org-1',
    user: { id: 'user-1' },
    inMemory: true,
    apiKey: 'test',
  };
  return Ablo(opts);
}

function getPool(sync: ReturnType<typeof createEngine>): ObjectPool {
  return sync._pool;
}

describe('attribution hydration (createdBy / organizationId)', () => {
  it('hydrates createdBy on create', () => {
    const pool = getPool(createEngine());
    if (!pool) return;

    const collection = pool.create('collections', {
      id: 'collection-1',
      title: 'Quarterly review',
      organizationId: 'org-1',
      createdBy: 'user-42',
    }) as Collection | null;

    expect(collection).not.toBeNull();
    expect(collection!.createdBy).toBe('user-42');
    expect(collection!.organizationId).toBe('org-1');
  });

  it('hydrates createdBy from an inbound delta (updateFromData)', () => {
    const pool = getPool(createEngine());
    if (!pool) return;

    const collection = pool.create('collections', {
      id: 'collection-2',
      title: 'Draft',
    }) as Collection | null;
    expect(collection).not.toBeNull();

    // Simulate a server delta carrying the stamped provenance.
    collection!.updateFromData({ createdBy: 'user-99', organizationId: 'org-2' });

    expect(collection!.createdBy).toBe('user-99');
    expect(collection!.organizationId).toBe('org-2');
  });

  it('supports the profile-page filter: collections.filter(d => d.createdBy === userId)', () => {
    const pool = getPool(createEngine());
    if (!pool) return;

    const mine = pool.create('collections', {
      id: 'collection-mine',
      title: 'Mine',
      createdBy: 'user-1',
    }) as Collection;
    const theirs = pool.create('collections', {
      id: 'collection-theirs',
      title: 'Theirs',
      createdBy: 'user-2',
    }) as Collection;

    const all = [mine, theirs];
    const userCollections = all.filter((d) => d.createdBy === 'user-1');

    expect(userCollections.map((d) => d.id)).toEqual(['collection-mine']);
  });
});
