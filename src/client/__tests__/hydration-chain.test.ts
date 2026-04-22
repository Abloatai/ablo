/**
 * Test: Schema → ModelRegistry → ObjectPool.createFromData → addBatch
 *
 * Verifies the full hydration chain that createSyncEngine relies on:
 * 1. registerModelsFromSchema populates the instance registry
 * 2. ObjectPool.createFromData resolves constructors from the registry
 * 3. Models created from raw IDB data land in the pool's typeIndex
 */

import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry';
import { ObjectPool } from '../../ObjectPool';
import { Model } from '../../Model';
import { ModelScope, LoadStrategy } from '../../types';
import { model } from '../../schema/model';
import { z } from 'zod';

// Minimal schema matching what the app uses
const testSchema = {
  models: {
    chats: model({
      id: z.string(),
      title: z.string(),
      userId: z.string(),
      organizationId: z.string(),
    }, {}, { typename: 'Chat' }),

    slideDecks: model({
      id: z.string(),
      title: z.string(),
      organizationId: z.string(),
    }, {}, { typename: 'SlideDeck' }),

    slideLayers: model({
      id: z.string(),
      slideId: z.string(),
      type: z.string(),
    }, {}, { typename: 'SlideLayer', load: 'lazy' }),
  },
};

function createDynamicClass(modelName: string) {
  return class extends Model {
    private _modelName = modelName;
    constructor(data?: Record<string, unknown>) {
      super(data);
    }
    getModelName(): string {
      return this._modelName;
    }
  };
}

function setupRegistryAndPool() {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });

  for (const [_schemaKey, modelDef] of Object.entries(testSchema.models)) {
    const modelName = modelDef.typename!;
    const isLazy = modelDef.load === 'lazy';
    const DynClass = createDynamicClass(modelName);

    registry.registerModel(modelName, DynClass, {
      loadStrategy: isLazy ? LoadStrategy.lazy : LoadStrategy.instant,
    });

    for (const fieldName of Object.keys(modelDef.shape)) {
      registry.registerProperty(modelName, fieldName, {
        type: 'property' as never,
        indexed: false,
        optional: false,
      });
    }
  }

  setActiveRegistry(registry);
  const pool = new ObjectPool({ maxSize: 10000 }, registry);

  return { registry, pool };
}

describe('Hydration chain: schema → registry → createFromData → pool', () => {
  it('registers all models including lazy', () => {
    const { registry } = setupRegistryAndPool();

    const allNames = registry.getRegisteredModelNames();
    expect(allNames).toContain('Chat');
    expect(allNames).toContain('SlideDeck');
    expect(allNames).toContain('SlideLayer');
  });

  it('stores correct load strategy from schema', () => {
    const { registry } = setupRegistryAndPool();

    expect(registry.getMetadata('Chat')?.loadStrategy).toBe(LoadStrategy.instant);
    expect(registry.getMetadata('SlideDeck')?.loadStrategy).toBe(LoadStrategy.instant);
    expect(registry.getMetadata('SlideLayer')?.loadStrategy).toBe(LoadStrategy.lazy);
  });

  it('createFromData produces a model when __typename matches', () => {
    const { pool } = setupRegistryAndPool();

    const m = pool.createFromData({
      __typename: 'Chat',
      id: 'chat-1',
      title: 'Test Chat',
      userId: 'user-1',
      organizationId: 'org-1',
    });

    expect(m).not.toBeNull();
    expect(m!.id).toBe('chat-1');
    expect(m!.getModelName()).toBe('Chat');
  });

  it('createFromData returns null for unknown typename', () => {
    const { pool } = setupRegistryAndPool();
    const m = pool.createFromData({ __typename: 'Bogus', id: 'x' });
    expect(m).toBeNull();
  });

  it('addBatch populates typeIndex so getByTypeName works', () => {
    const { pool } = setupRegistryAndPool();

    const models = [
      pool.createFromData({ __typename: 'Chat', id: 'c1', title: 'A', userId: 'u1', organizationId: 'o1' })!,
      pool.createFromData({ __typename: 'Chat', id: 'c2', title: 'B', userId: 'u1', organizationId: 'o1' })!,
      pool.createFromData({ __typename: 'SlideDeck', id: 'd1', title: 'Deck', organizationId: 'o1' })!,
    ];

    expect(models.every(Boolean)).toBe(true);

    const added = pool.addBatch(models, ModelScope.live);
    expect(added).toBe(3);

    expect(pool.getByTypeName('Chat')).toHaveLength(2);
    expect(pool.getByTypeName('SlideDeck')).toHaveLength(1);
  });

  it('getModelByName returns usable constructor', () => {
    const { registry } = setupRegistryAndPool();

    const Ctor = registry.getModelByName('Chat');
    expect(Ctor).toBeDefined();

    const instance = new Ctor({ id: 'test', title: 'hi' });
    expect(instance.getModelName()).toBe('Chat');
  });

  it('lazy models excluded from instant-only filter', () => {
    const { registry } = setupRegistryAndPool();

    const instant = registry.getModelsByLoadStrategy(LoadStrategy.instant);
    expect(instant).toContain('Chat');
    expect(instant).toContain('SlideDeck');
    expect(instant).not.toContain('SlideLayer');
  });

  it('createFromData works when dynamic class calls makeObservable()', () => {
    // This is the REAL test — production dynamic classes call makeObservable()
    // in their constructor, which triggers M1 → MobX setup. Our earlier tests
    // skipped this. If this fails, we've found the bug.
    const registry = new ModelRegistry({
      validateOnRegister: false,
      allowLateReferences: true,
    });

    const fields = ['title', 'userId'];
    const DynClass = class extends Model {
      private _modelName = 'TestModel';
      constructor(data?: Record<string, unknown>) {
        super(data);
        // Same pattern as production createDynamicModelClass:
        // set schema fields as own properties before makeObservable
        for (const f of fields) {
          if (!(f in this)) {
            (this as Record<string, unknown>)[f] = data?.[f] ?? undefined;
          }
        }
        this.makeObservable();
      }
      getModelName(): string {
        return this._modelName;
      }
    };

    registry.registerModel('TestModel', DynClass, { loadStrategy: LoadStrategy.instant });
    registry.registerProperty('TestModel', 'title', {
      type: 'property' as never,
      indexed: false,
      optional: false,
    });
    registry.registerProperty('TestModel', 'userId', {
      type: 'property' as never,
      indexed: false,
      optional: false,
    });

    setActiveRegistry(registry);
    const pool = new ObjectPool({ maxSize: 1000 }, registry);

    const m = pool.createFromData({
      __typename: 'TestModel',
      id: 'test-1',
      title: 'Hello',
      userId: 'u1',
    });

    expect(m).not.toBeNull();
    expect(m!.id).toBe('test-1');
    expect(m!.getModelName()).toBe('TestModel');
  });

  it('simulates full hydration: raw IDB data → createFromData → addBatch → getByTypeName', () => {
    const { pool } = setupRegistryAndPool();

    // Simulate raw IDB rows (no __typename, just like real IDB data)
    const rawIdbRows = [
      { id: 'c1', title: 'Chat 1', userId: 'u1', organizationId: 'o1' },
      { id: 'c2', title: 'Chat 2', userId: 'u1', organizationId: 'o1' },
      { id: 'c3', title: 'Chat 3', userId: 'u2', organizationId: 'o1' },
    ];

    // Hydration loop adds __typename (same as SyncClient.hydrateFromDatabase)
    const modelType = 'Chat';
    const models: Model[] = [];
    for (const data of rawIdbRows) {
      const withType = { __typename: modelType, ...data };
      const m = pool.createFromData(withType);
      if (m) models.push(m);
    }

    expect(models).toHaveLength(3);

    pool.addBatch(models, ModelScope.live);
    expect(pool.getByTypeName('Chat')).toHaveLength(3);
    expect(pool.size).toBe(3);
  });
});

describe('Schema computed getters', () => {
  // Use the real createDynamicModelClass indirectly by testing
  // the computed getter installation pattern.

  function setupWithComputed(computedGetters: Record<string, (self: Record<string, unknown>) => unknown>) {
    const registry = new ModelRegistry({
      validateOnRegister: false,
      allowLateReferences: true,
    });

    const fields = ['title', 'metadata'];
    const DynClass = class extends Model {
      private _modelName = 'TestChat';
      constructor(data?: Record<string, unknown>) {
        super(data);
        for (const f of fields) {
          if (!(f in this)) {
            (this as Record<string, unknown>)[f] = data?.[f] ?? undefined;
          }
        }
        this.makeObservable();
      }
      getModelName(): string {
        return this._modelName;
      }
    };

    // Install computed getters on prototype (same as createDynamicModelClass)
    for (const [name, fn] of Object.entries(computedGetters)) {
      Object.defineProperty(DynClass.prototype, name, {
        get(this: Record<string, unknown>) { return fn(this); },
        enumerable: true,
        configurable: true,
      });
    }

    registry.registerModel('TestChat', DynClass, { loadStrategy: LoadStrategy.instant });
    registry.registerProperty('TestChat', 'title', { type: 'property' as never, indexed: false, optional: false });
    registry.registerProperty('TestChat', 'metadata', { type: 'property' as never, indexed: false, optional: false });
    setActiveRegistry(registry);

    const pool = new ObjectPool({ maxSize: 1000 }, registry);
    return { pool };
  }

  it('metadataObject parses JSON string metadata', () => {
    const metadataObject = (self: Record<string, unknown>): Record<string, unknown> => {
      try {
        const raw = self.metadata;
        if (!raw) return {};
        const parsed = typeof raw === 'string' ? JSON.parse(raw as string) : raw;
        if (parsed === null || typeof parsed !== 'object') return {};
        return parsed as Record<string, unknown>;
      } catch { return {}; }
    };

    const { pool } = setupWithComputed({
      metadataObject,
      icon: (self) => ((self.metadataObject as Record<string, unknown>)?.icon as string) ?? 'default-icon',
      displayTitle: (self) => self.title || 'Untitled',
    });

    const m = pool.createFromData({
      __typename: 'TestChat',
      id: 'c1',
      title: 'My Chat',
      metadata: JSON.stringify({ icon: 'rocket', color: '#FF0000', type: 'workspace-chat' }),
    }) as unknown as Record<string, unknown>;

    expect(m).not.toBeNull();
    expect(m.metadataObject).toEqual({ icon: 'rocket', color: '#FF0000', type: 'workspace-chat' });
    expect(m.icon).toBe('rocket');
    expect(m.displayTitle).toBe('My Chat');
  });

  it('displayTitle falls back when title is empty', () => {
    const { pool } = setupWithComputed({
      displayTitle: (self) => self.title || 'Untitled',
    });

    const m = pool.createFromData({
      __typename: 'TestChat',
      id: 'c2',
      title: '',
      metadata: '{}',
    }) as unknown as Record<string, unknown>;

    expect(m.displayTitle).toBe('Untitled');
  });

  it('metadataObject returns {} for null/invalid metadata', () => {
    const metadataObject = (self: Record<string, unknown>): Record<string, unknown> => {
      try {
        const raw = self.metadata;
        if (!raw) return {};
        const parsed = typeof raw === 'string' ? JSON.parse(raw as string) : raw;
        if (parsed === null || typeof parsed !== 'object') return {};
        return parsed as Record<string, unknown>;
      } catch { return {}; }
    };

    const { pool } = setupWithComputed({ metadataObject });

    const m1 = pool.createFromData({ __typename: 'TestChat', id: 'c3', title: 'A', metadata: null as unknown as string }) as unknown as Record<string, unknown>;
    expect(m1.metadataObject).toEqual({});

    const m2 = pool.createFromData({ __typename: 'TestChat', id: 'c4', title: 'B', metadata: 'not-json' }) as unknown as Record<string, unknown>;
    expect(m2.metadataObject).toEqual({});
  });

  it('chained computed: icon reads from metadataObject (same as production schema)', () => {
    // Exactly mimics the schema.ts pattern:
    // metadataObject parses JSON, icon reads from metadataObject
    const metadataObject = (self: Record<string, unknown>): Record<string, unknown> => {
      try {
        const raw = self.metadata;
        if (!raw) return {};
        const parsed = typeof raw === 'string' ? JSON.parse(raw as string) : raw;
        if (parsed === null || typeof parsed !== 'object') return {};
        return parsed as Record<string, unknown>;
      } catch { return {}; }
    };

    const metaProp = (key: string, fallback: string) =>
      (self: Record<string, unknown>) =>
        ((self.metadataObject as Record<string, unknown> | undefined)?.[key] as string) ?? fallback;

    const { pool } = setupWithComputed({
      metadataObject,
      icon: metaProp('icon', 'message-circle'),
      color: metaProp('color', '#8B5CF6'),
      displayTitle: (self) => self.title || 'Untitled',
    });

    const m = pool.createFromData({
      __typename: 'TestChat',
      id: 'c5',
      title: 'Test',
      metadata: JSON.stringify({ type: 'workspace-chat', icon: 'rocket', color: '#00FF00' }),
    }) as unknown as Record<string, unknown>;

    expect(m).not.toBeNull();
    expect(m.metadataObject).toEqual({ type: 'workspace-chat', icon: 'rocket', color: '#00FF00' });
    expect(m.icon).toBe('rocket');
    expect(m.color).toBe('#00FF00');
    expect(m.displayTitle).toBe('Test');

    // Verify chaining works: icon falls back when metadata has no icon
    const m2 = pool.createFromData({
      __typename: 'TestChat',
      id: 'c6',
      title: '',
      metadata: '{}',
    }) as unknown as Record<string, unknown>;

    expect(m2.icon).toBe('message-circle');
    expect(m2.color).toBe('#8B5CF6');
    expect(m2.displayTitle).toBe('Untitled');
  });
});
