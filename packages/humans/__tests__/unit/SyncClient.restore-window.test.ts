/**
 * Restore-time fail-closed guard for the browser pending-mutation journal.
 *
 * Sealed commit envelopes already refuse to replay past the 23-hour server
 * idempotency window. Journaled-but-unsealed writes used to escape it: they
 * re-sealed on restore with a fresh clock, so a weeks-old offline write could
 * replay long after the server had forgotten its idempotency key. The window
 * must anchor to when the write was made — the mutation's own timestamp —
 * because any clock stamped at restore time would reset its own expiry.
 *
 * Expired records are held for review (warned, left on disk), never silently
 * replayed and never deleted.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { InstanceCache as ObjectPool } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { SyncClient } from '../../src/local/SyncClient';
import { PENDING_MUTATION_REPLAY_WINDOW_MS } from '../../src/local/transactions/mutations/replayValidation';
import {
  fakeDatabase,
  registerTestModels,
  createTestConfig,
  createTestContext,
  type TestContextResult,
} from '../../src/local/testing';

const SCOPE = {
  organizationId: 'org-1',
  participantId: 'user-1',
  namespace: 'default',
};

function pendingMutationRow(options: {
  mutationId: string;
  writtenAt: number;
}): Record<string, unknown> {
  return {
    id: `pending-mutation:${options.mutationId}`,
    type: 'pending_mutation',
    storageVersion: 2,
    scope: SCOPE,
    timestamp: options.writtenAt,
    mutation: {
      mutationId: options.mutationId,
      type: 'update',
      modelName: 'SlideLayer',
      modelData: {
        __typename: 'SlideLayer',
        id: `layer-${options.mutationId}`,
        slideId: 'slide-1',
      },
      timestamp: new Date(options.writtenAt).toISOString(),
    },
  };
}

describe('SyncClient pending-mutation restore window', () => {
  let registry: ModelRegistry;
  let pool: ObjectPool;
  let client: SyncClient;
  let ctx: TestContextResult;
  let storedRows: Record<string, unknown>[];
  let removedIds: string[];

  beforeEach(() => {
    registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    ctx = createTestContext({ config: createTestConfig() });
    pool = new ObjectPool({ maxSize: 1000, gcInterval: 0, useWeakRefs: false }, registry);
    storedRows = [];
    removedIds = [];
    const database = fakeDatabase({
      saveTransaction: () => Promise.resolve(undefined),
      getPersistedTransactions: () => Promise.resolve(storedRows),
      removeTransaction: (id: string) => {
        removedIds.push(id);
        return Promise.resolve();
      },
      getStore: () => undefined,
      clear: () => Promise.resolve(undefined),
    });
    client = new SyncClient(pool, database);
  });

  afterEach(() => {
    client.disconnect();
    pool.clear();
    ctx.cleanup();
  });

  it('holds a journaled write older than the replay window and keeps the fresh one', async () => {
    storedRows = [
      pendingMutationRow({
        mutationId: 'mut-stale',
        writtenAt: Date.now() - PENDING_MUTATION_REPLAY_WINDOW_MS - 1,
      }),
      pendingMutationRow({ mutationId: 'mut-fresh', writtenAt: Date.now() }),
    ];

    await client.initialize('user-1', 'org-1');

    expect(client.getSyncStats().pendingMutations).toBe(1);
    // Held for review, not destroyed: the stale record stays on disk.
    expect(removedIds).not.toContain('pending-mutation:mut-stale');
  });

  it('holds a record whose write timestamp cannot be parsed', async () => {
    const row = pendingMutationRow({ mutationId: 'mut-garbled', writtenAt: Date.now() });
    (row.mutation as Record<string, unknown>).timestamp = 'not-a-date';
    storedRows = [row];

    await client.initialize('user-1', 'org-1');

    expect(client.getSyncStats().pendingMutations).toBe(0);
    expect(removedIds).not.toContain('pending-mutation:mut-garbled');
  });

  it('keeps the legacy mutation-queue row while any of its entries is held', async () => {
    storedRows = [
      {
        id: 'mutation-queue',
        mutations: [
          {
            type: 'update',
            modelName: 'SlideLayer',
            modelData: {
              __typename: 'SlideLayer',
              id: 'layer-legacy-stale',
              slideId: 'slide-1',
            },
            timestamp: new Date(
              Date.now() - PENDING_MUTATION_REPLAY_WINDOW_MS - 1,
            ).toISOString(),
          },
        ],
      },
    ];

    await client.initialize('user-1', 'org-1');

    expect(client.getSyncStats().pendingMutations).toBe(0);
    expect(removedIds).not.toContain('mutation-queue');
  });

  it('removes the legacy mutation-queue row once every entry migrates', async () => {
    storedRows = [
      {
        id: 'mutation-queue',
        mutations: [
          {
            type: 'update',
            modelName: 'SlideLayer',
            modelData: {
              __typename: 'SlideLayer',
              id: 'layer-legacy-fresh',
              slideId: 'slide-1',
            },
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ];

    await client.initialize('user-1', 'org-1');

    expect(client.getSyncStats().pendingMutations).toBe(1);
    expect(removedIds).toContain('mutation-queue');
  });
});
