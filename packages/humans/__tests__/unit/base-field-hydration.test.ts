/**
 * Base-field hydration regression test.
 *
 * `organizationId` and `createdBy` live in `baseFieldsSchema`, NOT in a
 * model's per-field `shape` (e.g. the real `slideDecks` model only declares
 * `title`/`layoutId`/`themeId`/`metadata`). The server stamps + emits these
 * base fields (camelCased on the wire), but hydration only assigns keys that
 * already exist as a property on the instance.
 *
 * The bug this guards: the dynamic-model factory seeded property slots ONLY
 * from `shape`, so `deck.createdBy` was never given a slot → every inbound
 * `createdBy` was silently dropped → `deck.createdBy === undefined`. The
 * profile decks tab filters `decks.filter(d => d.createdBy === userId)`, so it
 * could NEVER surface a person's decks.
 *
 * These models deliberately do NOT declare base fields in `shape`, mirroring
 * the real schema, so the test fails on the pre-fix code and passes after.
 */

import { z } from 'zod';
import { model } from '@ablo/transaction/schema/model';
import { defineSchema } from '@ablo/transaction/schema/schema';
import { Ablo, type InternalAbloOptions } from '../../src/Ablo';
import { Model } from '../../src/local/Model';
import type { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';

// Mirrors `slideDecks`: base fields are intentionally absent from `shape`.
interface Deck extends Model {
  title: string;
  organizationId?: string;
  createdBy?: string;
}

const schema = defineSchema({
  decks: model({
    title: z.string(),
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

describe('base-field hydration (createdBy / organizationId)', () => {
  it('hydrates createdBy on create even though it is not in the model shape', () => {
    const pool = getPool(createEngine());
    if (!pool) return;

    const deck = pool.create('decks', {
      id: 'deck-1',
      title: 'Quarterly review',
      organizationId: 'org-1',
      createdBy: 'user-42',
    }) as Deck | null;

    expect(deck).not.toBeNull();
    expect(deck!.createdBy).toBe('user-42');
    expect(deck!.organizationId).toBe('org-1');
  });

  it('hydrates createdBy from an inbound delta (updateFromData)', () => {
    const pool = getPool(createEngine());
    if (!pool) return;

    const deck = pool.create('decks', {
      id: 'deck-2',
      title: 'Draft',
    }) as Deck | null;
    expect(deck).not.toBeNull();

    // Simulate a server delta carrying the stamped provenance.
    deck!.updateFromData({ createdBy: 'user-99', organizationId: 'org-2' });

    expect(deck!.createdBy).toBe('user-99');
    expect(deck!.organizationId).toBe('org-2');
  });

  it('supports the profile-page filter: decks.filter(d => d.createdBy === userId)', () => {
    const pool = getPool(createEngine());
    if (!pool) return;

    const mine = pool.create('decks', {
      id: 'deck-mine',
      title: 'Mine',
      createdBy: 'user-1',
    }) as Deck;
    const theirs = pool.create('decks', {
      id: 'deck-theirs',
      title: 'Theirs',
      createdBy: 'user-2',
    }) as Deck;

    const all = [mine, theirs];
    const userDecks = all.filter((d) => d.createdBy === 'user-1');

    expect(userDecks.map((d) => d.id)).toEqual(['deck-mine']);
  });
});
