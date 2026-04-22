/**
 * Test Model subclasses for @ablo/sync-engine tests.
 *
 * Lightweight Model implementations with FK relationships matching
 * the MODEL_CREATE_PRIORITY map in TransactionQueue:
 *   TestProject (10) → TestTask (10, FK→Project) → TestComment (30, FK→Task)
 *   TestSlideDeck (10) → TestSlide (15, FK→SlideDeck) → TestSlideLayer (20, FK→Slide)
 */

import { Model } from '../../Model';
import { ModelRegistry } from '../../ModelRegistry';
import { PropertyType, LoadStrategy } from '../../types';

// ─────────────────────────────────────────────
// Test Model Classes
// ─────────────────────────────────────────────

export class TestProject extends Model {
  name = '';
  description = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestProject> & Record<string, unknown> = {}) {
    super(data);
    if (data.name != null) this.name = data.name as string;
    if (data.description != null) this.description = data.description as string;
    if (data.organizationId != null) this.organizationId = data.organizationId as string;
  }

  getModelName(): string {
    return 'Project';
  }
}

export class TestTask extends Model {
  title = '';
  status = 'todo';
  projectId: string | null = null;
  assigneeId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestTask> & Record<string, unknown> = {}) {
    super(data);
    if (data.title != null) this.title = data.title as string;
    if (data.status != null) this.status = data.status as string;
    if (data.projectId !== undefined) this.projectId = data.projectId as string | null;
    if (data.assigneeId !== undefined) this.assigneeId = data.assigneeId as string | null;
    if (data.organizationId != null) this.organizationId = data.organizationId as string;
  }

  getModelName(): string {
    return 'Task';
  }
}

export class TestComment extends Model {
  body = '';
  taskId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestComment> & Record<string, unknown> = {}) {
    super(data);
    if (data.body != null) this.body = data.body as string;
    if (data.taskId !== undefined) this.taskId = data.taskId as string | null;
    if (data.organizationId != null) this.organizationId = data.organizationId as string;
  }

  getModelName(): string {
    return 'Comment';
  }
}

export class TestSlideDeck extends Model {
  title = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestSlideDeck> & Record<string, unknown> = {}) {
    super(data);
    if (data.title != null) this.title = data.title as string;
    if (data.organizationId != null) this.organizationId = data.organizationId as string;
  }

  getModelName(): string {
    return 'SlideDeck';
  }
}

export class TestSlide extends Model {
  order = 0;
  deckId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestSlide> & Record<string, unknown> = {}) {
    super(data);
    if (data.order != null) this.order = data.order as number;
    if (data.deckId !== undefined) this.deckId = data.deckId as string | null;
    if (data.organizationId != null) this.organizationId = data.organizationId as string;
  }

  getModelName(): string {
    return 'Slide';
  }
}

export class TestSlideLayer extends Model {
  slideId: string | null = null;
  zIndex = 0;
  type = 'text';
  content = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestSlideLayer> & Record<string, unknown> = {}) {
    super(data);
    if (data.slideId !== undefined) this.slideId = data.slideId as string | null;
    if (data.zIndex != null) this.zIndex = data.zIndex as number;
    if (data.type != null) this.type = data.type as string;
    if (data.content != null) this.content = data.content as string;
    if (data.organizationId != null) this.organizationId = data.organizationId as string;
  }

  getModelName(): string {
    return 'SlideLayer';
  }
}

// ─────────────────────────────────────────────
// Model Registration Helper
// ─────────────────────────────────────────────

/**
 * Model → priority mapping matching TransactionQueue's MODEL_CREATE_PRIORITY.
 */
export const TEST_MODEL_PRIORITIES = new Map<string, number>([
  ['Project', 10],
  ['Task', 10],
  ['SlideDeck', 10],
  ['Slide', 15],
  ['SlideLayer', 20],
  ['Comment', 30],
]);

/**
 * Register all test models with a ModelRegistry instance.
 * Sets up properties, references, and FK relationships.
 */
export function registerTestModels(registry: ModelRegistry): void {
  registry.startBatch();

  // Register model classes
  registry.registerModel('Project', TestProject, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('Task', TestTask, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('Comment', TestComment, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('SlideDeck', TestSlideDeck, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('Slide', TestSlide, { loadStrategy: LoadStrategy.instant });
  registry.registerModel('SlideLayer', TestSlideLayer, { loadStrategy: LoadStrategy.instant });

  // Register properties
  registry.registerProperty('Project', 'name', { type: PropertyType.property });
  registry.registerProperty('Project', 'description', { type: PropertyType.property, optional: true });
  registry.registerProperty('Project', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('Task', 'title', { type: PropertyType.property });
  registry.registerProperty('Task', 'status', { type: PropertyType.property });
  registry.registerProperty('Task', 'projectId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Task', 'assigneeId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Task', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('Comment', 'body', { type: PropertyType.property });
  registry.registerProperty('Comment', 'taskId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Comment', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('SlideDeck', 'title', { type: PropertyType.property });
  registry.registerProperty('SlideDeck', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('Slide', 'order', { type: PropertyType.property });
  registry.registerProperty('Slide', 'deckId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('Slide', 'organizationId', { type: PropertyType.property });

  registry.registerProperty('SlideLayer', 'slideId', { type: PropertyType.reference, nullable: true });
  registry.registerProperty('SlideLayer', 'zIndex', { type: PropertyType.property });
  registry.registerProperty('SlideLayer', 'type', { type: PropertyType.property });
  registry.registerProperty('SlideLayer', 'content', { type: PropertyType.property });
  registry.registerProperty('SlideLayer', 'organizationId', { type: PropertyType.property });

  // Register back-references for cascade-aware transaction handling
  registry.registerBackReference('Task', { parentModel: 'Project', foreignKey: 'projectId', cascadeDelete: true });
  registry.registerBackReference('Comment', { parentModel: 'Task', foreignKey: 'taskId', cascadeDelete: true });
  registry.registerBackReference('Slide', { parentModel: 'SlideDeck', foreignKey: 'deckId', cascadeDelete: true });
  registry.registerBackReference('SlideLayer', { parentModel: 'Slide', foreignKey: 'slideId', cascadeDelete: true });

  registry.endBatch();
}

// ─────────────────────────────────────────────
// Test SyncEngineConfig factory
// ─────────────────────────────────────────────

/**
 * Create a SyncEngineConfig pre-configured with test model priorities.
 */
export function createTestConfig(): {
  modelCreatePriority: ReadonlyMap<string, number>;
  defaultCreatePriority: number;
  defaultNonCreatePriority: number;
  batchableModels: ReadonlySet<string>;
  dedicatedDeleteModels: ReadonlySet<string>;
  essentialFields: Readonly<Record<string, readonly string[]>>;
  classNameFallbackMap: Readonly<Record<string, string>>;
  preserveCaseModels: ReadonlySet<string>;
} {
  return {
    modelCreatePriority: TEST_MODEL_PRIORITIES,
    defaultCreatePriority: 40,
    defaultNonCreatePriority: 50,
    batchableModels: new Set(['task', 'project', 'comment', 'slide', 'slidelayer', 'slidedeck']),
    dedicatedDeleteModels: new Set(),
    essentialFields: {
      Task: ['title', 'projectId'],
      Slide: ['deckId', 'order'],
    },
    classNameFallbackMap: {
      TestProject: 'Project',
      TestTask: 'Task',
      TestComment: 'Comment',
      TestSlideDeck: 'SlideDeck',
      TestSlide: 'Slide',
      TestSlideLayer: 'SlideLayer',
    },
    preserveCaseModels: new Set(['SlideLayer', 'SlideDeck']),
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

export function createProjectFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestProject {
  fixtureCounter++;
  return new TestProject({
    id: `project-${fixtureCounter}`,
    name: `Test Project ${fixtureCounter}`,
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createTaskFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestTask {
  fixtureCounter++;
  return new TestTask({
    id: `task-${fixtureCounter}`,
    title: `Test Task ${fixtureCounter}`,
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

export function createSlideDeckFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestSlideDeck {
  fixtureCounter++;
  return new TestSlideDeck({
    id: `deck-${fixtureCounter}`,
    title: `Test Deck ${fixtureCounter}`,
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createSlideFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestSlide {
  fixtureCounter++;
  return new TestSlide({
    id: `slide-${fixtureCounter}`,
    order: fixtureCounter,
    organizationId: 'test-org',
    ...overrides,
  });
}

export function createSlideLayerFixture(
  overrides: Partial<Record<string, unknown>> = {}
): TestSlideLayer {
  fixtureCounter++;
  return new TestSlideLayer({
    id: `layer-${fixtureCounter}`,
    zIndex: fixtureCounter,
    type: 'text',
    content: `Layer content ${fixtureCounter}`,
    organizationId: 'test-org',
    ...overrides,
  });
}
