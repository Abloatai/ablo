/**
 * Contract test: Subpath exports verification
 *
 * Verifies that all documented subpath exports are importable
 * and export the expected symbols. This prevents accidental
 * breaking changes to the public API surface.
 */

describe('Contract: Subpath Exports', () => {
  describe('@ablo/sync-engine (main)', () => {
    it('should export Model', () => {
      const { Model } = require('../../src/index');
      expect(Model).toBeDefined();
      expect(typeof Model).toBe('function');
    });

    it('should export ModelScope', () => {
      const { ModelScope } = require('../../src/index');
      expect(ModelScope).toBeDefined();
      expect(ModelScope.live).toBe('live');
      expect(ModelScope.archived).toBe('archived');
      expect(ModelScope.all).toBe('all');
    });

    it('should export LazyReferenceCollection', () => {
      const { LazyReferenceCollection } = require('../../src/index');
      expect(LazyReferenceCollection).toBeDefined();
    });
  });

  describe('@ablo/sync-engine/core', () => {
    it('should export BaseSyncedStore', () => {
      const { BaseSyncedStore } = require('../../src/core/index');
      expect(BaseSyncedStore).toBeDefined();
    });

    it('should export SyncClient', () => {
      const { SyncClient } = require('../../src/core/index');
      expect(SyncClient).toBeDefined();
    });

    it('should export Database', () => {
      const { Database } = require('../../src/core/index');
      expect(Database).toBeDefined();
    });

    it('should export ObjectPool', () => {
      const { ObjectPool } = require('../../src/core/index');
      expect(ObjectPool).toBeDefined();
    });

    it('should export ModelRegistry', () => {
      const { ModelRegistry } = require('../../src/core/index');
      expect(ModelRegistry).toBeDefined();
    });

    it('should export TransactionQueue', () => {
      const { TransactionQueue } = require('../../src/core/index');
      expect(TransactionQueue).toBeDefined();
    });

    it('should export SyncWebSocket', () => {
      const { SyncWebSocket } = require('../../src/core/index');
      expect(SyncWebSocket).toBeDefined();
    });

    it('should export NetworkMonitor', () => {
      const { NetworkMonitor } = require('../../src/core/index');
      expect(NetworkMonitor).toBeDefined();
    });
  });

  describe('@ablo/sync-engine/schema', () => {
    it('should export defineSchema', () => {
      const { defineSchema } = require('../../src/schema/index');
      expect(defineSchema).toBeDefined();
      expect(typeof defineSchema).toBe('function');
    });

    it('should export field builder', () => {
      const { field } = require('../../src/schema/index');
      expect(field).toBeDefined();
      expect(typeof field.string).toBe('function');
      expect(typeof field.number).toBe('function');
      expect(typeof field.boolean).toBe('function');
    });

    it('should export relation builder', () => {
      const { relation } = require('../../src/schema/index');
      expect(relation).toBeDefined();
      expect(typeof relation.belongsTo).toBe('function');
    });
  });

  describe('@ablo/sync-engine/react', () => {
    it('should export useOne hook', () => {
      const { useOne } = require('../../src/react/index');
      expect(useOne).toBeDefined();
      expect(typeof useOne).toBe('function');
    });

    it('should export useQuery hook', () => {
      const { useQuery } = require('../../src/react/index');
      expect(useQuery).toBeDefined();
      expect(typeof useQuery).toBe('function');
    });

    it('should export useMutate hook', () => {
      const { useMutate } = require('../../src/react/index');
      expect(useMutate).toBeDefined();
      expect(typeof useMutate).toBe('function');
    });
  });

  describe('@ablo/sync-engine/testing', () => {
    it('should export MockMutationExecutor', () => {
      const { MockMutationExecutor } = require('../../src/testing/index');
      expect(MockMutationExecutor).toBeDefined();
    });

    it('should export createTestContext', () => {
      const { createTestContext } = require('../../src/testing/index');
      expect(createTestContext).toBeDefined();
      expect(typeof createTestContext).toBe('function');
    });

    it('should export createTestHarness', () => {
      const { createTestHarness } = require('../../src/testing/index');
      expect(createTestHarness).toBeDefined();
      expect(typeof createTestHarness).toBe('function');
    });

    it('should export fixture factories', () => {
      const {
        createTaskFixture,
        createProjectFixture,
        createDelta,
        createInsertDelta,
        createFullBootstrapResponse,
      } = require('../../src/testing/index');

      expect(typeof createTaskFixture).toBe('function');
      expect(typeof createProjectFixture).toBe('function');
      expect(typeof createDelta).toBe('function');
      expect(typeof createInsertDelta).toBe('function');
      expect(typeof createFullBootstrapResponse).toBe('function');
    });

    it('should export wait helpers', () => {
      const { flushMicrotasks, waitFor, delay } = require('../../src/testing/index');
      expect(typeof flushMicrotasks).toBe('function');
      expect(typeof waitFor).toBe('function');
      expect(typeof delay).toBe('function');
    });
  });

  describe('@ablo/sync-engine/types', () => {
    it('should export PropertyType enum', () => {
      const { PropertyType } = require('../../src/types');
      expect(PropertyType).toBeDefined();
      expect(PropertyType.property).toBe('property');
      expect(PropertyType.reference).toBe('reference');
    });

    it('should export LoadStrategy enum', () => {
      const { LoadStrategy } = require('../../src/types');
      expect(LoadStrategy).toBeDefined();
      expect(LoadStrategy.instant).toBe('instant');
      expect(LoadStrategy.lazy).toBe('lazy');
    });

    it('should export MutationOperationType enum', () => {
      const { MutationOperationType } = require('../../src/types');
      expect(MutationOperationType).toBeDefined();
      expect(MutationOperationType.CREATE).toBe('CREATE');
      expect(MutationOperationType.DELETE).toBe('DELETE');
    });
  });
});
