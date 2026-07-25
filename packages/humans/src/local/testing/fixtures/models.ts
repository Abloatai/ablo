/**
 * A small set of {@link Model} subclasses used across the package's tests.
 * They form two foreign-key chains and carry the creation priorities the
 * transaction queue uses to order dependent writes:
 *   TestProject (10) → TestTask (10, references Project) → TestComment (30, references Task)
 *   TestSlideDeck (10) → TestSlide (15, references SlideDeck) → TestSlideLayer (20, references Slide)
 */

import { Model } from '../../Model.js';
import { ModelRegistry } from '../../ModelRegistry.js';
import { PropertyType, LoadStrategy } from '@abloatai/transaction/types';

// ─────────────────────────────────────────────
// Test Model Classes
// ─────────────────────────────────────────────

export class TestProject extends Model {
  name = '';
  description = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestProject> & Record<string, unknown> = {}) {
    super(data);
    if (data.name != null) this.name = data.name;
    if (data.description != null) this.description = data.description;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
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
    if (data.title != null) this.title = data.title;
    if (data.status != null) this.status = data.status;
    if (data.projectId !== undefined) this.projectId = data.projectId;
    if (data.assigneeId !== undefined) this.assigneeId = data.assigneeId;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'Task';
  }
}

export class TestComment extends Model {
  body = '';
  taskId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestComment> & Record<string, unknown> = {}) {
    super(data);
    if (data.body != null) this.body = data.body;
    if (data.taskId !== undefined) this.taskId = data.taskId;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'Comment';
  }
}

export class TestSlideDeck extends Model {
  title = '';
  organizationId = 'test-org';

  constructor(data: Partial<TestSlideDeck> & Record<string, unknown> = {}) {
    super(data);
    if (data.title != null) this.title = data.title;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'SlideDeck';
  }
}

export class TestSlide extends Model {
  order = 0;
  deckId: string | null = null;
  organizationId = 'test-org';

  constructor(data: Partial<TestSlide> & Record<string, unknown> = {}) {
    super(data);
    if (data.order != null) this.order = data.order;
    if (data.deckId !== undefined) this.deckId = data.deckId;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
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
    if (data.slideId !== undefined) this.slideId = data.slideId;
    if (data.zIndex != null) this.zIndex = data.zIndex;
    if (data.type != null) this.type = data.type;
    if (data.content != null) this.content = data.content;
    if (data.organizationId != null) this.organizationId = data.organizationId;
  }

  override getModelName(): string {
    return 'SlideLayer';
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
  ['Project', 10],
  ['Task', 10],
  ['SlideDeck', 10],
  ['Slide', 15],
  ['SlideLayer', 20],
  ['Comment', 30],
]);

/**
 * Registers every test model with a {@link ModelRegistry}, wiring up their
 * properties, references, and foreign-key relationships.
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
