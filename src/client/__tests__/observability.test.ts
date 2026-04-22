/**
 * Test: Per-field MobX observability for schema-driven dynamic models.
 *
 * Isolates the behavior introduced by wiring `lazyObservable: true` on the
 * model definition to `this.makeObservable()` in the dynamic class
 * constructor. Verifies that:
 *
 *   1. Setting a field on an instance fires a MobX reaction.
 *   2. Mutating a nested property (e.g. `layer.position.x = 500`) fires a
 *      reaction — matches the pre-migration behavior drag/resize relies on.
 *   3. `updateFromData(newData)` — how remote deltas arrive from the sync
 *      WebSocket — also fires reactions.
 *   4. Plain (non-`lazyObservable`) models do NOT fire reactions on field
 *      mutation — confirms the opt-in gate.
 */

import { autorun, reaction } from 'mobx';
import { ModelRegistry, setActiveRegistry } from '../../ModelRegistry';
import { Model } from '../../Model';
import { PropertyType, LoadStrategy } from '../../types';

/**
 * Shape of the test fields installed on every model instance. Lets the test
 * body read/write fields without repeated casts.
 */
interface TestFields {
  title?: string;
  position?: { x: number; y: number; width: number; height: number };
  contentJSON?: { type: string; content: unknown[] };
}

/**
 * Build a Model subclass that mimics what `createDynamicModelClass`
 * produces when a schema has `lazyObservable: true`. We deliberately call
 * the inherited `Model.makeObservable()` in the constructor — same code
 * path the SDK's dynamic class now uses.
 */
function buildObservableModelClass(modelName: string, lazyObservable: boolean) {
  const ModelClass = class extends Model {
    private _modelName = modelName;
    // No TypeScript field declarations here — they'd initialize to `undefined`
    // and mask values coming from `data`. The assignment loop in the
    // constructor is the source of truth; the external cast at the `return`
    // below gives callers the typed `TestFields` projection.
    constructor(data?: Record<string, unknown>) {
      super(data);
      // Initialize fields as own properties so `makeObservable()` can
      // annotate them (MobX 6 requires own-property existence before
      // annotation). Always overwrite — we want the `data` value, not
      // whatever any base class default installed.
      const fieldNames = ['title', 'position', 'contentJSON'] as const;
      for (const field of fieldNames) {
        (this as Record<string, unknown>)[field] = data?.[field];
      }
      if (lazyObservable) {
        this.makeObservable();
      }
    }
    getModelName(): string {
      return this._modelName;
    }
  };
  return ModelClass as new (data?: Record<string, unknown>) => Model & TestFields;
}

/** Register a model type's fields with the registry so M1 can annotate. */
function registerType(
  registry: ModelRegistry,
  modelName: string,
  ModelClass: new (data?: Record<string, unknown>) => Model,
): void {
  registry.registerModel(modelName, ModelClass, { loadStrategy: LoadStrategy.instant });
  for (const fieldName of ['title', 'position', 'contentJSON']) {
    registry.registerProperty(modelName, fieldName, {
      type: PropertyType.property,
      indexed: false,
      optional: true,
    });
  }
}

describe('Dynamic model observability (lazyObservable opt-in)', () => {
  it('fires a MobX reaction when an observable field is set', () => {
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    setActiveRegistry(registry);
    const Cls = buildObservableModelClass('TestSlide', true);
    registerType(registry, 'TestSlide', Cls);

    const instance = new Cls({ id: 'slide-1', title: 'Initial' });
    const reads: string[] = [];
    const dispose = autorun(() => reads.push(instance.title!));

    instance.title = 'Updated';

    expect(reads).toEqual(['Initial', 'Updated']);
    dispose();
  });

  it('fires a reaction when a nested property is mutated (deep observability)', () => {
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    setActiveRegistry(registry);
    const Cls = buildObservableModelClass('TestLayer', true);
    registerType(registry, 'TestLayer', Cls);

    const instance = new Cls({
      id: 'layer-1',
      position: { x: 0, y: 0, width: 100, height: 100 },
    });

    const observed: number[] = [];
    const dispose = reaction(
      () => instance.position!.x,
      (x) => observed.push(x),
      { fireImmediately: true },
    );

    // Simulate a drag step: in-place mutation on the nested JSON column.
    instance.position!.x = 500;

    expect(observed).toEqual([0, 500]);
    dispose();
  });

  it('fires a reaction when updateFromData replaces a field (remote delta path)', () => {
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    setActiveRegistry(registry);
    const Cls = buildObservableModelClass('TestText', true);
    registerType(registry, 'TestText', Cls);

    const instance = new Cls({
      id: 'text-1',
      contentJSON: { type: 'doc', content: [] },
    });

    const contentSnapshots: unknown[] = [];
    const dispose = autorun(() => {
      contentSnapshots.push(instance.contentJSON);
    });

    // Simulate a remote delta landing on the same entity.
    instance.updateFromData({
      id: 'text-1',
      contentJSON: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    expect(contentSnapshots.length).toBeGreaterThanOrEqual(2);
    expect(
      (contentSnapshots[contentSnapshots.length - 1] as { content: unknown[] }).content,
    ).toHaveLength(1);
    dispose();
  });

  it('exposes contentJSON after construction with initial data (TipTap render path)', () => {
    // Reproduces the reported regression: "cant see the contents of the
    // textlayers / contentjson". After the observable wiring, the renderer
    // reads `layer.contentJSON` and passes it straight into TipTap. This
    // test confirms the field survives construction + makeObservable.
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    setActiveRegistry(registry);
    const Cls = buildObservableModelClass('SlideLayer', true);
    registerType(registry, 'SlideLayer', Cls);

    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] },
      ],
    };
    const instance = new Cls({ id: 'l1', contentJSON: doc });

    const out = instance.contentJSON;
    expect(out).toBeDefined();
    expect(out?.type).toBe('doc');
    expect(out?.content).toHaveLength(1);
  });

  it('preserves contentJSON through pool.createFromData (the real ingest path)', async () => {
    // `ObjectPool.createFromData` is what bootstrap + WebSocket deltas call.
    // If the observable wiring interferes with field assignment during
    // construction, contentJSON would come out undefined — exactly the
    // symptom the user reported.
    const { ObjectPool } = await import('../../ObjectPool');
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    setActiveRegistry(registry);
    const Cls = buildObservableModelClass('SlideLayer', true);
    registerType(registry, 'SlideLayer', Cls);

    const pool = new ObjectPool({ maxSize: 100 }, registry);
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    };

    const m = pool.createFromData({
      __typename: 'SlideLayer',
      id: 'l1',
      contentJSON: doc,
    });

    expect(m).not.toBeNull();
    const fields = m as unknown as TestFields;
    expect(fields.contentJSON).toBeDefined();
    expect(fields.contentJSON?.type).toBe('doc');
    expect(fields.contentJSON?.content).toHaveLength(1);
  });

  it('leaves string-serialized contentJSON as-is (no automatic JSON.parse)', async () => {
    // Some wire formats ship JSON columns as stringified JSON. If the SDK
    // doesn't parse them, renderers get a string where they expect an
    // object, and TipTap silently renders nothing. This test documents the
    // CURRENT behavior so we know whether to add parsing at ingest or at
    // the consumer edge.
    const { ObjectPool } = await import('../../ObjectPool');
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    setActiveRegistry(registry);
    const Cls = buildObservableModelClass('SlideLayer', true);
    registerType(registry, 'SlideLayer', Cls);

    const pool = new ObjectPool({ maxSize: 100 }, registry);
    const serialized = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
    });

    const m = pool.createFromData({
      __typename: 'SlideLayer',
      id: 'l1',
      contentJSON: serialized,
    });

    const fields = m as unknown as TestFields;
    // Currently: the SDK stores the raw string — no JSON.parse happens in
    // the ingest path. If this assertion flips (future behavior change),
    // update consumer code accordingly.
    expect(typeof fields.contentJSON).toBe('string');
  });

  it('does NOT fire reactions on plain (non-lazyObservable) models', () => {
    const registry = new ModelRegistry({ validateOnRegister: false, allowLateReferences: true });
    setActiveRegistry(registry);
    const Cls = buildObservableModelClass('PlainSidebarRow', false);
    registerType(registry, 'PlainSidebarRow', Cls);

    const instance = new Cls({ id: 'row-1', title: 'Initial' });
    const reads: string[] = [];
    const dispose = autorun(() => reads.push(instance.title!));

    instance.title = 'Changed';

    // Only the initial autorun read should have fired — plain models don't
    // emit MobX reactions.
    expect(reads).toEqual(['Initial']);
    dispose();
  });
});
