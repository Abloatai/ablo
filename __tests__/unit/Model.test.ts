/**
 * Model unit tests — UUID generation, dirty tracking, validation,
 * disposed flag, updateFromData, lifecycle.
 */

import {
  createTestContext,
  TestTask,
  TestProject,
  createTaskFixture,
  resetFixtureCounter,
} from '../../src/testing';
import { Model, ValidationError } from '../../src/Model';

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
      const task = new TestTask({ id: 'custom-id' });
      expect(task.id).toBe('custom-id');
    });

    it('should auto-generate id if not provided', () => {
      const task = new TestTask({});
      expect(task.id).toBeDefined();
      expect(task.id.length).toBeGreaterThan(0);
    });

    it('should set clientId equal to id (no temp IDs)', () => {
      const task = new TestTask({ id: 'my-id' });
      expect(task.clientId).toBe('my-id');
    });
  });

  describe('dirty tracking', () => {
    it('should start with no changes', () => {
      const task = createTaskFixture();
      expect(task.hasChanges).toBe(false);
      expect(task.getChanges()).toEqual({});
    });

    it('should track property changes', () => {
      const task = createTaskFixture({ title: 'Old' });
      task.propertyChanged('title', 'Old', 'New');

      expect(task.hasChanges).toBe(true);
      expect(task.getChanges()).toEqual({ title: 'New' });
    });

    it('should skip no-op changes (same value)', () => {
      const task = createTaskFixture({ title: 'Same' });
      task.propertyChanged('title', 'Same', 'Same');

      expect(task.hasChanges).toBe(false);
    });

    it('should clear changes on clearChanges()', () => {
      const task = createTaskFixture({ title: 'Old' });
      task.propertyChanged('title', 'Old', 'New');
      expect(task.hasChanges).toBe(true);

      task.clearChanges();
      expect(task.hasChanges).toBe(false);
    });
  });

  describe('isNew / markAsPersisted', () => {
    it('should start as new', () => {
      const task = createTaskFixture();
      expect(task.isNew()).toBe(true);
    });

    it('should not be new after markAsPersisted()', () => {
      const task = createTaskFixture();
      task.markAsPersisted();
      expect(task.isNew()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('should mark model as disposed', () => {
      const task = createTaskFixture();
      expect(task.disposed).toBe(false);

      task.dispose();
      expect(task.disposed).toBe(true);
    });

    it('should be idempotent', () => {
      const task = createTaskFixture();
      task.dispose();
      task.dispose(); // Should not throw
      expect(task.disposed).toBe(true);
    });

    it('should throw on updateFromData after dispose', () => {
      const task = createTaskFixture();
      task.dispose();

      expect(() => task.updateFromData({ title: 'Nope' })).toThrow('Cannot update disposed model');
    });

    it('should throw on validate after dispose', () => {
      const task = createTaskFixture();
      task.dispose();

      expect(() => task.validate()).toThrow('Cannot validate disposed model');
    });

    it('should throw on prepareSave after dispose', () => {
      const task = createTaskFixture();
      task.dispose();

      expect(() => task.prepareSave()).toThrow('Cannot prepare save for disposed model');
    });

    it('should throw on prepareDelete after dispose', () => {
      const task = createTaskFixture();
      task.dispose();

      expect(() => task.prepareDelete()).toThrow('Cannot prepare delete for disposed model');
    });
  });

  describe('updateFromData', () => {
    it('should update fields from data object', () => {
      const task = createTaskFixture({ title: 'Old', status: 'todo' });
      task.updateFromData({ title: 'New', status: 'done' });

      expect(task.title).toBe('New');
      expect(task.status).toBe('done');
    });

    it('should not override id', () => {
      const task = createTaskFixture();
      const originalId = task.id;
      task.updateFromData({ id: 'should-be-ignored' });

      expect(task.id).toBe(originalId);
    });

    it('should convert date strings to Date objects', () => {
      const task = createTaskFixture();
      const dateStr = '2025-06-15T10:00:00.000Z';
      task.updateFromData({ createdAt: dateStr });

      expect(task.createdAt).toBeInstanceOf(Date);
      expect(task.createdAt?.toISOString()).toBe(dateStr);
    });
  });

  describe('prepareSave', () => {
    it('should return create operation for new model', () => {
      const task = createTaskFixture({ title: 'New task' });
      const changes = task.prepareSave();

      expect(changes).toBeDefined();
      expect(changes!.type).toBe('create');
      expect(changes!.modelName).toBe('Task');
      expect(changes!.modelId).toBe(task.id);
    });

    it('should return update operation for persisted model with changes', () => {
      const task = createTaskFixture({ title: 'Old' });
      task.markAsPersisted();
      task.propertyChanged('title', 'Old', 'New');

      const changes = task.prepareSave();

      expect(changes).toBeDefined();
      expect(changes!.type).toBe('update');
    });

    it('should return null for persisted model without changes', () => {
      const task = createTaskFixture();
      task.markAsPersisted();

      const changes = task.prepareSave();
      expect(changes).toBeNull();
    });
  });

  describe('prepareDelete', () => {
    it('should return delete operation', () => {
      const task = createTaskFixture();
      const changes = task.prepareDelete();

      expect(changes.type).toBe('delete');
      expect(changes.modelName).toBe('Task');
      expect(changes.modelId).toBe(task.id);
    });
  });

  describe('prepareArchive / prepareUnarchive', () => {
    it('should return archive operation and set archivedAt', () => {
      const task = createTaskFixture();
      const changes = task.prepareArchive();

      expect(changes.type).toBe('archive');
      expect(task.archivedAt).toBeInstanceOf(Date);
    });

    it('should return unarchive operation and clear archivedAt', () => {
      const task = createTaskFixture();
      task.archivedAt = new Date();
      const changes = task.prepareUnarchive();

      expect(changes.type).toBe('unarchive');
      expect(task.archivedAt).toBeNull();
    });
  });

  describe('getModelName', () => {
    it('should return registered model name', () => {
      const task = createTaskFixture();
      expect(task.getModelName()).toBe('Task');
    });

    it('should return correct name for each test model', () => {
      expect(new TestTask({}).getModelName()).toBe('Task');
      expect(new TestProject({}).getModelName()).toBe('Project');
    });
  });

  describe('equals', () => {
    it('should return true for same id and constructor', () => {
      const task1 = new TestTask({ id: 'same-id' });
      const task2 = new TestTask({ id: 'same-id' });

      expect(task1.equals(task2)).toBe(true);
    });

    it('should return false for different ids', () => {
      const task1 = createTaskFixture();
      const task2 = createTaskFixture();

      expect(task1.equals(task2)).toBe(false);
    });
  });

  describe('toJSON', () => {
    it('should include __class and __typename', () => {
      const task = createTaskFixture();
      const json = task.toJSON();

      expect(json.__class).toBe('Task');
      expect(json.__typename).toBe('Task');
    });

    it('should include id and timestamps', () => {
      const task = createTaskFixture();
      const json = task.toJSON();

      expect(json.id).toBe(task.id);
      expect(json.createdAt).toBeDefined();
      expect(json.updatedAt).toBeDefined();
    });
  });

  describe('syncStatus', () => {
    it('should start as pending', () => {
      const task = createTaskFixture();
      expect(task.getSyncStatus()).toBe('pending');
    });

    it('should update via markAsSynced', () => {
      const task = createTaskFixture();
      task.markAsSynced();
      expect(task.getSyncStatus()).toBe('synced');
    });

    it('should update via markAsPending', () => {
      const task = createTaskFixture();
      task.markAsSynced();
      task.markAsPending();
      expect(task.getSyncStatus()).toBe('pending');
    });
  });

  describe('getFieldChanges', () => {
    it('should return field changes with types', () => {
      const task = createTaskFixture({ title: 'Old' });
      task.propertyChanged('title', 'Old', 'New');

      const changes = task.getFieldChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].field).toBe('title');
      expect(changes[0].oldValue).toBe('Old');
      expect(changes[0].newValue).toBe('New');
      expect(changes[0].fieldType).toBe('string');
    });
  });
});
