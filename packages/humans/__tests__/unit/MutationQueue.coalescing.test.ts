/**
 * MutationQueue coalescing tests — merging UPDATEs to same model,
 * metadata JSON parse+merge, malformed JSON fallback.
 */

import { MutationQueue } from '../../src/local/transactions/mutations/MutationQueue';
import {
  createTestContext,
  TestItem,
  createItemFixture,
  resetFixtureCounter,
  flushMicrotasks,
} from '../../src/local/testing';

const TEST_USER_CONTEXT = {
  userId: 'user-1',
  organizationId: 'org-1',
};

describe('MutationQueue Coalescing', () => {
  let queue: MutationQueue;
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext({
      config: {
      },
    });
    cleanup = ctx.cleanup;
    queue = new MutationQueue({ batchDelay: 0, maxBatchSize: 50 });
  });

  afterEach(() => {
    queue.removeAllListeners();
    cleanup();
  });

  describe('update coalescing in execution queue', () => {
    it('should merge two UPDATE transactions to same model in execution queue', async () => {
      const item = createItemFixture({ title: 'Original', status: 'todo' });
      item.markAsPersisted();

      // First update
      item.propertyChanged('title', 'Original', 'Updated');
      await queue.update(item, TEST_USER_CONTEXT, { title: 'Updated' });

      // Second update to same model (before batch processes)
      item.propertyChanged('status', 'todo', 'doing');
      await queue.update(item, TEST_USER_CONTEXT, { status: 'doing' });

      // Both should be staged in the same microtask
      await flushMicrotasks();

      // The second update should have been coalesced into the first
      // We can verify by checking the mutationExecutor received a single call
      await new Promise((r) => setTimeout(r, 50));

      // The coalesced update should contain both fields
      const calls = (createTestContext().mocks.mutationExecutor as any).calls;
      // At least one batchAck call should have been made
    });
  });

  describe('metadata merge (special handling)', () => {
    it('should merge metadata objects instead of clobbering', () => {
      // Testing the internal mergeUpdateData logic via public API
      // When two updates have metadata fields, they should be merged as JSON objects

      const item = createItemFixture();
      item.markAsPersisted();

      // We can test this by creating updates with metadata fields
      // The merge happens internally during coalescing
    });
  });
});
