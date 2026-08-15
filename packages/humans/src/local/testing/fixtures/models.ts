/**
 * A small set of {@link Model} subclasses used across the package's tests.
 * They form two foreign-key chains and carry the creation priorities the
 * transaction queue uses to order dependent writes:
 *   TestWorkspace (10) → TestItem (10, references Workspace) → TestComment (30, references Item)
 *   TestEntryCollection (10) → TestEntry (15, references Collection) → TestEntryLayer (20, references Entry)
 */

import { Model } from '../../Model.js';
import { ModelRegistry } from '../../ModelRegistry.js';
import { PropertyType, LoadStrategy } from '@abloatai/transaction/types';

// ─────────────────────────────────────────────
// Test Model Classes
// ─────────────────────────────────────────────

export class TestWorkspace extends Model {
  name = '';
  description = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestWorkspace> & Record<string, unknown> = {}) {
    super(data);
    if (data.name != null) this.name = data.name;
    if (data.description != null) this.description = data.description;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'Workspace';
  }
}

export class TestItem extends Model {
  title = '';
  status = 'todo';
  workspaceId: string | null = null;
  assigneeId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestItem> & Record<string, unknown> = {}) {
    super(data);
    if (data.title != null) this.title = data.title;
    if (data.status != null) this.status = data.status;
    if (data.workspaceId !== undefined) this.workspaceId = data.workspaceId;
    if (data.assigneeId !== undefined) this.assigneeId = data.assigneeId;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'Item';
  }
}

export class TestComment extends Model {
  body = '';
  itemId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestComment> & Record<string, unknown> = {}) {
    super(data);
    if (data.body != null) this.body = data.body;
    if (data.itemId !== undefined) this.itemId = data.itemId;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'Comment';
  }
}

export class TestEntryCollection extends Model {
  title = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestEntryCollection> & Record<string, unknown> = {}) {
    super(data);
    if (data.title != null) this.title = data.title;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'Collection';
  }
}

export class TestEntry extends Model {
  order = 0;
  collectionId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestEntry> & Record<string, unknown> = {}) {
    super(data);
    if (data.order != null) this.order = data.order;
    if (data.collectionId !== undefined) this.collectionId = data.collectionId;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'Entry';
  }
}

export class TestEntryLayer extends Model {
  entryId: string | null = null;
  zIndex = 0;
  type = 'text';
  content = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestEntryLayer> & Record<string, unknown> = {}) {
    super(data);
    if (data.entryId !== undefined) this.entryId = data.entryId;
    if (data.zIndex != null) this.zIndex = data.zIndex;
    if (data.type != null) this.type = data.type;
    if (data.content != null) this.content = data.content;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'EntryDetail';
  }
}

// ─────────────────────────────────────────────
// Model Registration Helper
// ─────────────────────────────────────────────

/**
 * Maps each test model to its creation priority, matching the order the
 * transaction queue uses when writing dependent models.
 */
export const TEST_MODEL_PRIORITIES = new Map<string, number>([
  ['Workspace', 10],
  ['Item', 10],
  ['Collection', 10],
  ['Entry', 15],
  ['EntryDetail', 20],
  ['Comment', 30],
]);

/**
 * Registers every test model with a {@link ModelRegistry}, wiring up their
 * properties, references, and foreign-key relationships.
 */
export function registerTestModels(registry: ModelRegistry): void {
  registry.startBatch();

  // Register model classes
  registry.registerModel('Workspace', TestWorkspace, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('Item', TestItem, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('Comment', TestComment, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('Collection', TestEntryCollection, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('Entry', TestEntry, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('EntryDetail', TestEntryLayer, { loadStrategy: LoadStrategy.instant });

  // Register properties
  registry.registerProperty('Workspace', 'name', { type: PropertyType.property });
  registry.registerProperty('Workspace', 'description', { type: PropertyType.property, optional: true });
  registry.registerProperty('Workspace', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('Item', 'title', { type: PropertyType.property });
  registry.registerProperty('Item', 'status', { type: PropertyType.property });
  registry.registerProperty('Item', 'workspaceId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Item', 'assigneeId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Item', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('Comment', 'body', { type: PropertyType.property });
  registry.registerProperty('Comment', 'itemId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Comment', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('Collection', 'title', { type: PropertyType.property });
  registry.registerProperty('Collection', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('Entry', 'order', { type: PropertyType.property });
  registry.registerProperty('Entry', 'collectionId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Entry', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('EntryDetail', 'entryId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('EntryDetail', 'zIndex', { type: PropertyType.property });
  registry.registerProperty('EntryDetail', 'type', { type: PropertyType.property });
  registry.registerProperty('EntryDetail', 'content', { type: PropertyType.property });
  registry.registerProperty('EntryDetail', 'organizationId', { type: PropertyType.property });

  // Register back-references for cascade-aware transaction handling
  registry.registerBackReference('Item', { parentModel: 'Workspace', foreignKey: 'workspaceId', cascadeDelete: true });
  registry.registerBackReference('Comment', { parentModel: 'Item', foreignKey: 'itemId', cascadeDelete: true });
  registry.registerBackReference('Entry', { parentModel: 'Collection', foreignKey: 'collectionId', cascadeDelete: true });
  registry.registerBackReference('EntryDetail', { parentModel: 'Entry', foreignKey: 'entryId', cascadeDelete: true });

  registry.endBatch();
}

// ─────────────────────────────────────────────
// Test SyncEngineConfig factory
// ─────────────────────────────────────────────

/**
 * Builds a sync engine configuration pre-loaded with the test models'
 * creation priorities and related settings.
 */
export function createTestConfig(): {
  modelCreatePriority: ReadonlyMap<string, number>;
  defaultCreatePriority: number;
  defaultNonCreatePriority: number;
  essentialFields: Readonly<Record<string, readonly string[]>>;
  classNameFallbackMap: Readonly<Record<string, string>>;
} {
  return {
    modelCreatePriority: TEST_MODEL_PRIORITIES,
    defaultCreatePriority: 40,
    defaultNonCreatePriority: 50,
    essentialFields: {
      Item: ['title', 'workspaceId'],
      Entry: ['collectionId', 'order'],
    },
    classNameFallbackMap: {
      TestWorkspace: 'Workspace',
      TestItem: 'Item',
      TestComment: 'Comment',
      TestEntryCollection: 'Collection',
      TestEntry: 'Entry',
      TestEntryLayer: 'EntryDetail',
    },
  };
}

// ─────────────────────────────────────────────
// Fixture factories
// ─────────────────────────────────────────────

let fixtureCounter = 0;

/** Reset the counter (call in beforeEach for deterministic IDs) */
export function resetFixtureCounter(): void {
  fixtureCounter = 0;
}

export function createWorkspaceFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestWorkspace {
  fixtureCounter++;
  return new TestWorkspace({
    id: `workspace-${fixtureCounter}`,
    name: `Test Workspace ${fixtureCounter}`,
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createItemFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestItem {
  fixtureCounter++;
  return new TestItem({
    id: `item-${fixtureCounter}`,
    title: `Test Item ${fixtureCounter}`,
    status: 'todo',
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createCommentFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestComment {
  fixtureCounter++;
  return new TestComment({
    id: `comment-${fixtureCounter}`,
    body: `Test comment ${fixtureCounter}`,
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createEntryCollectionFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestEntryCollection {
  fixtureCounter++;
  return new TestEntryCollection({
    id: `collection-${fixtureCounter}`,
    title: `Test Collection ${fixtureCounter}`,
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createEntryFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestEntry {
  fixtureCounter++;
  return new TestEntry({
    id: `entry-${fixtureCounter}`,
    order: fixtureCounter,
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createEntryLayerFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestEntryLayer {
  fixtureCounter++;
  return new TestEntryLayer({
    id: `layer-${fixtureCounter}`,
    zIndex: fixtureCounter,
    type: 'text',
    content: `Layer content ${fixtureCounter}`,
    organizationId: 'test-org',
    ...overrides,
  });
}
