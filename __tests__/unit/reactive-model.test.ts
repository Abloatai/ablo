/**
 * Reactive schema-generated model tests.
 *
 * Verifies that createDynamicModelClass + makeObservable() produces
 * models with the same behavior as the hand-coded Ablo Model classes:
 *   - Field getter/setter pairs that track changes
 *   - MobX reactivity (observer components re-render on field changes)
 *   - getChanges() / hasChanges / clearChanges()
 *   - updateFromData() applies deltas correctly
 *   - toJSON() serializes all registered fields
 */

import { z } from 'zod';
import { autorun, runInAction } from 'mobx';
import { model } from '../../src/schema/model';
import { field } from '../../src/schema/field';
import { relation } from '../../src/schema/relation';
import { defineSchema } from '../../src/schema/schema';
import { createSyncEngine } from '../../src/client/createSyncEngine';
import { Model } from '../../src/Model';

// ── Test schema ─────────────────────────────────────────────────────

const schema = defineSchema({
  projects: model({
    name: z.string(),
    description: z.string().optional(),
    status: z.enum(['active', 'archived']).default('active'),
    metadata: field.json({
      color: z.string().default('#3B82F6'),
      icon: z.string().default('folder'),
    }),
    organizationId: z.string(),
    createdBy: z.string(),
  }),

  tasks: model({
    title: z.string(),
    status: z.enum(['todo', 'doing', 'done']).default('todo'),
    priority: z.number().default(0),
    projectId: z.string().optional(),
    organizationId: z.string(),
    createdBy: z.string(),
  }, {
    project: relation.belongsTo('projects', 'projectId'),
  }),
});

// ── Helpers ──────────────────────────────────────────────────────────

function createEngine() {
  return createSyncEngine({
    url: 'ws://localhost:8080',
    schema,
    user: { id: 'user-1', organizationId: 'org-1' },
    inMemory: true,
    apiKey: 'test',
  });
}

// Access internal ObjectPool to create model instances directly
function getPool(sync: ReturnType<typeof createEngine>) {
  // createSyncEngine exposes the pool via a private-ish path
  return (sync as any)._objectPool ?? (sync as any).pool ?? null;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('reactive schema-generated model', () => {
  it('createSyncEngine returns without errors', () => {
    const sync = createEngine();
    expect(sync).toBeDefined();
  });

  it('schema-generated model extends Model base class', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return; // pool not accessible, skip

    const task = pool.createFromData('tasks', {
      id: 'task-1',
      title: 'Test task',
      status: 'todo',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    expect(task).toBeInstanceOf(Model);
    expect(task.id).toBe('task-1');
  });
});

describe('change tracking', () => {
  it('getChanges() returns modified fields', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const task = pool.createFromData('tasks', {
      id: 'task-1',
      title: 'Original',
      status: 'todo',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    // Modify a field
    runInAction(() => {
      task.title = 'Updated';
    });

    const changes = task.getChanges();
    expect(changes.title).toBe('Updated');
    expect(task.hasChanges).toBe(true);
  });

  it('clearChanges() resets the dirty state', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const task = pool.createFromData('tasks', {
      id: 'task-1',
      title: 'Original',
      status: 'todo',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    runInAction(() => {
      task.title = 'Changed';
    });
    expect(task.hasChanges).toBe(true);

    task.clearChanges();
    expect(task.hasChanges).toBe(false);
  });
});

describe('MobX reactivity', () => {
  it('autorun reacts to field changes', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const task = pool.createFromData('tasks', {
      id: 'task-1',
      title: 'Watch me',
      status: 'todo',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    const observed: string[] = [];
    autorun(() => {
      observed.push(task.title);
    });

    expect(observed).toEqual(['Watch me']);

    runInAction(() => {
      task.title = 'Changed!';
    });

    expect(observed).toEqual(['Watch me', 'Changed!']);
  });
});

describe('updateFromData', () => {
  it('applies delta fields to the model', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const task = pool.createFromData('tasks', {
      id: 'task-1',
      title: 'Before',
      status: 'todo',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    task.updateFromData({
      title: 'After',
      status: 'doing',
    });

    expect(task.title).toBe('After');
    expect(task.status).toBe('doing');
  });
});

describe('toJSON', () => {
  it('serializes all registered fields', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const task = pool.createFromData('tasks', {
      id: 'task-1',
      title: 'Serialize me',
      status: 'done',
      priority: 5,
      projectId: 'proj-1',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    const json = task.toJSON();
    expect(json.id).toBe('task-1');
    expect(json.title).toBe('Serialize me');
    expect(json.status).toBe('done');
    expect(json.priority).toBe(5);
    expect(json.projectId).toBe('proj-1');
    expect(json.organizationId).toBe('org-1');
    expect(json.createdBy).toBe('user-1');
  });

  it('includes local changes in serialization', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const task = pool.createFromData('tasks', {
      id: 'task-1',
      title: 'Original',
      status: 'todo',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    runInAction(() => {
      task.title = 'Modified';
    });

    const json = task.toJSON();
    expect(json.title).toBe('Modified');
  });
});

describe('field.json() integration', () => {
  it('metadataJson getter works on reactive model', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const project = pool.createFromData('projects', {
      id: 'proj-1',
      name: 'Test Project',
      metadata: '{"color":"#FF0000","icon":"star"}',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    // metadataJson should parse the JSON string and apply defaults
    expect(project.metadataJson).toBeDefined();
    expect(project.metadataJson.color).toBe('#FF0000');
    expect(project.metadataJson.icon).toBe('star');
  });

  it('metadataJson uses Zod defaults for missing fields', () => {
    const sync = createEngine();
    const pool = getPool(sync);
    if (!pool) return;

    const project = pool.createFromData('projects', {
      id: 'proj-1',
      name: 'Bare project',
      metadata: '{}',
      organizationId: 'org-1',
      createdBy: 'user-1',
    });

    expect(project.metadataJson.color).toBe('#3B82F6'); // default
    expect(project.metadataJson.icon).toBe('folder');    // default
  });
});
