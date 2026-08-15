/**
 * Model unit tests — UUID generation, dirty tracking, validation,
 * disposed flag, updateFromData, lifecycle.
 */

import {
  createTestContext,
  TestItem,
  TestWorkspace,
  createItemFixture,
  resetFixtureCounter,
} from '../../src/local/testing';
import { Model, ValidationError } from '../../src/local/Model';

describe('Model', () => {
  let cleanup: () => void;

  beforeEach(() => {
    resetFixtureCounter();
    const ctx = createTestContext();
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  describe('ID generation', () => {
    it('should generate a UUID via Model.generateId()', () => {
      const id = Model.generateId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should generate unique IDs on each call', () => {
      const ids = new Set(Array.from({ length: 100 }, () => Model.generateId()));
      expect(ids.size).toBe(100);
    });

    it('should use provided id in constructor', () => {
      const item = new TestItem({ id: 'custom-id' });
      expect(item.id).toBe('custom-id');
    });

    it('should auto-generate id if not provided', () => {
      const item = new TestItem({});
      expect(item.id).toBeDefined();
      expect(item.id.length).toBeGreaterThan(0);
    });

    it('should set clientId equal to id (no temp IDs)', () => {
      const item = new TestItem({ id: 'my-id' });
      expect(item.clientId).toBe('my-id');
    });
  });

  describe('dirty tracking', () => {
    it('should start with no changes', () => {
      const item = createItemFixture();
      expect(item.hasChanges).toBe(false);
      expect(item.getChanges()).toEqual({});
    });

    it('should track property changes', () => {
      const item = createItemFixture({ title: 'Old' });
      item.propertyChanged('title', 'Old', 'New');

      expect(item.hasChanges).toBe(true);
      expect(item.getChanges()).toEqual({ title: 'New' });
    });

    it('should skip no-op changes (same value)', () => {
      const item = createItemFixture({ title: 'Same' });
      item.propertyChanged('title', 'Same', 'Same');

      expect(item.hasChanges).toBe(false);
    });

    it('should clear changes on clearChanges()', () => {
      const item = createItemFixture({ title: 'Old' });
      item.propertyChanged('title', 'Old', 'New');
      expect(item.hasChanges).toBe(true);

      item.clearChanges();
      expect(item.hasChanges).toBe(false);
    });
  });

  describe('isNew / markAsPersisted', () => {
    it('should start as new', () => {
      const item = createItemFixture();
      expect(item.isNew()).toBe(true);
    });

    it('should not be new after markAsPersisted()', () => {
      const item = createItemFixture();
      item.markAsPersisted();
      expect(item.isNew()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('should mark model as disposed', () => {
      const item = createItemFixture();
      expect(item.disposed).toBe(false);

      item.dispose();
      expect(item.disposed).toBe(true);
    });

    it('should be idempotent', () => {
      const item = createItemFixture();
      item.dispose();
      item.dispose(); // Should not throw
      expect(item.disposed).toBe(true);
    });

    it('should throw on updateFromData after dispose', () => {
      const item = createItemFixture();
      item.dispose();

      expect(() => { item.updateFromData({ title: 'Nope' }); }).toThrow('Cannot update disposed model');
    });

    it('should throw on validate after dispose', () => {
      const item = createItemFixture();
      item.dispose();

      expect(() => item.validate()).toThrow('Cannot validate disposed model');
    });

    it('should throw on prepareSave after dispose', () => {
      const item = createItemFixture();
      item.dispose();

      expect(() => item.prepareSave()).toThrow('Cannot prepare save for disposed model');
    });

    it('should throw on prepareDelete after dispose', () => {
      const item = createItemFixture();
      item.dispose();

      expect(() => item.prepareDelete()).toThrow('Cannot prepare delete for disposed model');
    });
  });

  describe('updateFromData', () => {
    it('should update fields from data object', () => {
      const item = createItemFixture({ title: 'Old', status: 'todo' });
      item.updateFromData({ title: 'New', status: 'done' });

      expect(item.title).toBe('New');
      expect(item.status).toBe('done');
    });

    it('should not override id', () => {
      const item = createItemFixture();
      const originalId = item.id;
      item.updateFromData({ id: 'should-be-ignored' });

      expect(item.id).toBe(originalId);
    });

    it('should convert date strings to Date objects', () => {
      const item = createItemFixture();
      const dateStr = '2025-06-15T10:00:00.000Z';
      item.updateFromData({ createdAt: dateStr });

      expect(item.createdAt).toBeInstanceOf(Date);
      expect(item.createdAt?.toISOString()).toBe(dateStr);
    });
  });

  describe('prepareSave', () => {
    it('should return create operation for new model', () => {
      const item = createItemFixture({ title: 'New item' });
      const changes = item.prepareSave();

      expect(changes).toBeDefined();
      expect(changes!.type).toBe('create');
      expect(changes!.modelName).toBe('Item');
      expect(changes!.modelId).toBe(item.id);
    });

    it('should return update operation for persisted model with changes', () => {
      const item = createItemFixture({ title: 'Old' });
      item.markAsPersisted();
      item.propertyChanged('title', 'Old', 'New');

      const changes = item.prepareSave();

      expect(changes).toBeDefined();
      expect(changes!.type).toBe('update');
    });

    it('should return null for persisted model without changes', () => {
      const item = createItemFixture();
      item.markAsPersisted();

      const changes = item.prepareSave();
      expect(changes).toBeNull();
    });
  });

  describe('prepareDelete', () => {
    it('should return delete operation', () => {
      const item = createItemFixture();
      const changes = item.prepareDelete();

      expect(changes.type).toBe('delete');
      expect(changes.modelName).toBe('Item');
      expect(changes.modelId).toBe(item.id);
    });
  });

  describe('prepareArchive / prepareUnarchive', () => {
    it('should return archive operation and set archivedAt', () => {
      const item = createItemFixture();
      const changes = item.prepareArchive();

      expect(changes.type).toBe('archive');
      expect(item.archivedAt).toBeInstanceOf(Date);
    });

    it('should return unarchive operation and clear archivedAt', () => {
      const item = createItemFixture();
      item.archivedAt = new Date();
      const changes = item.prepareUnarchive();

      expect(changes.type).toBe('unarchive');
      expect(item.archivedAt).toBeNull();
    });
  });

  describe('getModelName', () => {
    it('should return registered model name', () => {
      const item = createItemFixture();
      expect(item.getModelName()).toBe('Item');
    });

    it('should return correct name for each test model', () => {
      expect(new TestItem({}).getModelName()).toBe('Item');
      expect(new TestWorkspace({}).getModelName()).toBe('Workspace');
    });
  });

  describe('equals', () => {
    it('should return true for same id and constructor', () => {
      const item1 = new TestItem({ id: 'same-id' });
      const item2 = new TestItem({ id: 'same-id' });

      expect(item1.equals(item2)).toBe(true);
    });

    it('should return false for different ids', () => {
      const item1 = createItemFixture();
      const item2 = createItemFixture();

      expect(item1.equals(item2)).toBe(false);
    });
  });

  describe('toJSON', () => {
    it('should include __class and __typename', () => {
      const item = createItemFixture();
      const json = item.toJSON();

      expect(json.__class).toBe('Item');
      expect(json.__typename).toBe('Item');
    });

    it('should include id and timestamps', () => {
      const item = createItemFixture();
      const json = item.toJSON();

      expect(json.id).toBe(item.id);
      expect(json.createdAt).toBeDefined();
      expect(json.updatedAt).toBeDefined();
    });
  });

  describe('syncStatus', () => {
    it('should start as pending', () => {
      const item = createItemFixture();
      expect(item.getSyncStatus()).toBe('pending');
    });

    it('should update via markAsSynced', () => {
      const item = createItemFixture();
      item.markAsSynced();
      expect(item.getSyncStatus()).toBe('synced');
    });

    it('should update via markAsPending', () => {
      const item = createItemFixture();
      item.markAsSynced();
      item.markAsPending();
      expect(item.getSyncStatus()).toBe('pending');
    });
  });

  describe('getFieldChanges', () => {
    it('should return field changes with types', () => {
      const item = createItemFixture({ title: 'Old' });
      item.propertyChanged('title', 'Old', 'New');

      const changes = item.getFieldChanges();
      expect(changes).toHaveLength(1);
      const change = changes[0];
      if (!change) throw new Error('expected one field change');
      expect(change.field).toBe('title');
      expect(change.oldValue).toBe('Old');
      expect(change.newValue).toBe('New');
      expect(change.fieldType).toBe('string');
    });
  });
});
