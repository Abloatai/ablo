/**
 * Performance benchmark — decomposes the delta-apply cost per mechanism.
 *
 * `applyDeltaBatchToPool` is the observer-side ceiling for a broad
 * subscription: one client thread's apply rate bounds how fast a single
 * consumer can drink an org's whole stream. This bench separates the apply
 * cost into its layers by running the SAME update stream through three pool
 * states:
 *
 *   activated    — models a consumer has read (M1 installed): every field
 *     write goes through the MobX setter, and the observe() bridge forwards
 *     changes to `propertyChanged` — except during hydration, which
 *     `_isHydrating` suppresses.
 *
 *   bridgeless   — activated, with the bridge's forward force-disabled.
 *     With the `_isHydrating` suppression in place this should measure the
 *     SAME as `activated`; a gap re-opening here means hydration is paying
 *     the bridge again.
 *
 *   cold         — rows no consumer has read; the apply loop resolves them
 *     with `pool.peek()` and field writes are plain property assignments.
 *     This is the whole-corpus state of a headless observer, and the path
 *     the 50k drain clause grades.
 *
 * Also reports the one-time M1 install cost per row — the activation charge
 * paid at a consumer-facing read, never by the delta stream.
 *
 * History: before `peek` (2026-07-28), the apply loop read rows through
 * `pool.get()`, whose `ensureObservable()` activated every row the stream
 * updated: apply measured 12.9 µs/delta against 2.9 cold on this bench's
 * host, and the activated path also paid the bridge during hydration.
 */

import { performance } from 'node:perf_hooks';
import { ModelRegistry, setActiveRegistry, clearActiveRegistry } from '../../src/local/ModelRegistry';
import { InstanceCache } from '../../src/local/InstanceCache';
import { Model, DEFER_MODEL_OBSERVABILITY } from '../../src/local/Model';
import { SyncClient } from '../../src/local/SyncClient';
import type { Database } from '../../src/local/Database';
import { ModelScope, LoadStrategy, PropertyType } from '@abloatai/transaction/types';

const FIELD_NAMES = ['title', 'status', 'organizationId', 'createdBy'] as const;

/**
 * Mirrors `createDynamicModelClass`: schema fields become own properties
 * before observability is decided, and the wire's defer marker keeps the
 * instance cold the way continuous delta ingestion does.
 */
class BenchItemModel extends Model {
  constructor(data?: Record<string, unknown>) {
    super(data);
    const defer = Reflect.get(data ?? {}, DEFER_MODEL_OBSERVABILITY) === true;
    (this as { _isConstructing?: boolean })._isConstructing = true;
    for (const field of FIELD_NAMES) {
      if (!(field in this)) {
        (this as Record<string, unknown>)[field] = data?.[field] ?? undefined;
      }
    }
    if (defer) {
      this.deferObservability();
    }
    (this as { _isConstructing?: boolean })._isConstructing = false;
  }

  override getModelName(): string {
    return 'Item';
  }
}

const ROWS = 8_000;
const FRAME_DELTAS = 1_300;
const FRAMES = 80;
const WARMUP_FRAMES = 8;

type DeltaResult = Parameters<SyncClient['applyDeltaBatchToPool']>[0][number];

const identityEnrich = (_name: string, data: Record<string, unknown>) => data;

function setup() {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registry.registerModel('Item', BenchItemModel, { loadStrategy: LoadStrategy.instant });
  for (const field of FIELD_NAMES) {
    registry.registerProperty('Item', field, { type: PropertyType.property, optional: true });
  }
  setActiveRegistry(registry);
  const pool = new InstanceCache({ maxSize: ROWS + 100 }, registry);
  const client = new SyncClient(pool, {} as Database);
  return { registry, pool, client };
}

function seedRows(pool: InstanceCache): BenchItemModel[] {
  const seeded: BenchItemModel[] = [];
  const createdAt = new Date().toISOString();
  for (let i = 0; i < ROWS; i++) {
    const data: Record<string, unknown> = {
      id: `row-${i}`,
      title: `seed-${i}`,
      status: 'todo',
      organizationId: 'org-bench',
      createdBy: 'user-bench',
      createdAt,
      updatedAt: createdAt,
    };
    Object.defineProperty(data, DEFER_MODEL_OBSERVABILITY, {
      value: true,
      enumerable: false,
      configurable: true,
    });
    const model = new BenchItemModel(data);
    model.markAsPersisted();
    seeded.push(model);
  }
  pool.addBatch(seeded, ModelScope.live);
  return seeded;
}

/** One flush-batch-sized frame of update deltas, round-robin over the corpus. */
function updateFrame(frameIndex: number): DeltaResult[] {
  const updatedAt = new Date().toISOString();
  return Array.from({ length: FRAME_DELTAS }, (_, i) => {
    const row = (frameIndex * FRAME_DELTAS + i) % ROWS;
    return {
      action: 'update' as const,
      modelName: 'Item',
      modelId: `row-${row}`,
      data: {
        id: `row-${row}`,
        title: `updated-${frameIndex}-${i}`,
        status: 'todo',
        organizationId: 'org-bench',
        createdBy: 'user-bench',
        updatedAt,
      },
    };
  });
}

interface ScenarioResult {
  scenario: string;
  totalDeltas: number;
  wallMs: number;
  perDeltaUs: number;
}

function runScenario(
  scenario: string,
  prepare: (models: BenchItemModel[]) => void,
  applyPatch?: () => () => void,
): ScenarioResult {
  const { pool, client } = setup();
  const models = seedRows(pool);
  prepare(models);

  const frames = Array.from({ length: FRAMES + WARMUP_FRAMES }, (_, i) => updateFrame(i));
  const restore = applyPatch?.();
  try {
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      client.applyDeltaBatchToPool(frames[i], identityEnrich);
    }
    const start = performance.now();
    for (let i = WARMUP_FRAMES; i < frames.length; i++) {
      client.applyDeltaBatchToPool(frames[i], identityEnrich);
    }
    const wallMs = performance.now() - start;

    // The stream was applied, not skipped: the corpus reflects the last frame.
    const lastFrame = frames[frames.length - 1];
    const lastDelta = lastFrame[lastFrame.length - 1];
    const witness = pool.get(lastDelta.modelId);
    expect(witness?.title).toBe((lastDelta.data as { title: string }).title);

    const totalDeltas = FRAMES * FRAME_DELTAS;
    return { scenario, totalDeltas, wallMs, perDeltaUs: (wallMs * 1000) / totalDeltas };
  } finally {
    restore?.();
    clearActiveRegistry();
  }
}

/** One flush-batch-sized frame of CREATE deltas with fresh ids. */
function addFrame(frameIndex: number): DeltaResult[] {
  const createdAt = new Date().toISOString();
  return Array.from({ length: FRAME_DELTAS }, (_, i) => {
    const id = `row-c-${frameIndex}-${i}`;
    return {
      action: 'add' as const,
      modelName: 'Item',
      modelId: id,
      data: {
        id,
        title: `created-${frameIndex}-${i}`,
        status: 'todo',
        organizationId: 'org-bench',
        createdBy: 'user-bench',
        createdAt,
        updatedAt: createdAt,
      },
    };
  });
}

type AddScenarioResult = ScenarioResult;

/**
 * Applies FRAMES add-frames of fresh rows through the client. `poolConfig`
 * selects the mechanism under test: the bench observer runs at the 10k
 * default cap (continuous eviction); an uncapped pool isolates eviction;
 * `useWeakRefs: false` isolates the per-add size probe + WeakRef.
 */
function runAddScenario(
  scenario: string,
  poolConfig: { maxSize: number; useWeakRefs?: boolean },
): AddScenarioResult {
  const { pool, client } = setup2(poolConfig);
  const frames = Array.from({ length: FRAMES + WARMUP_FRAMES }, (_, i) => addFrame(i));
  try {
    for (let i = 0; i < WARMUP_FRAMES; i++) {
      client.applyDeltaBatchToPool(frames[i], identityEnrich);
    }
    const start = performance.now();
    for (let i = WARMUP_FRAMES; i < frames.length; i++) {
      client.applyDeltaBatchToPool(frames[i], identityEnrich);
    }
    const wallMs = performance.now() - start;

    const lastFrame = frames[frames.length - 1];
    const lastDelta = lastFrame[lastFrame.length - 1];
    // A WeakRef-backed pool may legally have collected an unactivated row
    // under memory pressure; when the row is resident it must carry the
    // applied data. Only the strong-ref scenario can demand residency.
    const witness = pool.peek(lastDelta.modelId);
    if (witness || poolConfig.useWeakRefs === false) {
      expect(witness?.title).toBe((lastDelta.data as { title: string }).title);
    }

    const totalDeltas = FRAMES * FRAME_DELTAS;
    return { scenario, totalDeltas, wallMs, perDeltaUs: (wallMs * 1000) / totalDeltas };
  } finally {
    clearActiveRegistry();
  }
}

function setup2(poolConfig: { maxSize: number; useWeakRefs?: boolean }) {
  const registry = new ModelRegistry({
    validateOnRegister: false,
    allowLateReferences: true,
  });
  registry.registerModel('Item', BenchItemModel, { loadStrategy: LoadStrategy.instant });
  for (const field of FIELD_NAMES) {
    registry.registerProperty('Item', field, { type: PropertyType.property, optional: true });
  }
  setActiveRegistry(registry);
  const pool = new InstanceCache(poolConfig, registry);
  const client = new SyncClient(pool, {} as Database);
  return { registry, pool, client };
}

describe('applyDeltaBatchToPool cost decomposition', () => {
  afterEach(() => {
    clearActiveRegistry();
  });

  it('separates MobX instrumentation layers from the base apply cost', () => {
    // One-time M1 install cost, charged by first-touch activation today.
    const { pool } = setup();
    const models = seedRows(pool);
    const installStart = performance.now();
    for (const model of models) model.ensureObservable();
    const installMs = performance.now() - installStart;
    clearActiveRegistry();

    const instrumented = runScenario('activated (consumer-read)', (rows) => {
      for (const model of rows) model.ensureObservable();
    });

    const bridgeless = runScenario('activated, bridge force-off', (rows) => {
      for (const model of rows) {
        // Install the no-op BEFORE activation so M1's action annotation wraps
        // it; the observe() bridge then forwards changes into a void.
        Object.defineProperty(model, 'propertyChanged', {
          value: () => {
            /* intentionally empty */
          },
          writable: true,
          configurable: true,
        });
        model.ensureObservable();
      }
    });

    const cold = runScenario(
      'cold (peek apply)',
      () => {
        /* intentionally empty */
      },
      () => {
        // Simulate the apply loop reading the pool without activating: the
        // rows stay deferred, exactly the state a peek-based lookup preserves.
        const original = Model.prototype.ensureObservable;
        Model.prototype.ensureObservable = function noopEnsureObservable() {
          /* intentionally empty */
        };
        return () => {
          Model.prototype.ensureObservable = original;
        };
      },
    );

    const rows = [instrumented, bridgeless, cold];

    console.log('\n┌──────────────────────────────┬──────────────┬──────────┬─────────────┐');
    console.log('│ scenario                     │ deltas       │  wallMs  │ per-delta µs│');
    console.log('├──────────────────────────────┼──────────────┼──────────┼─────────────┤');
    for (const r of rows) {
      console.log(
        `│ ${r.scenario.padEnd(28)} │ ${String(r.totalDeltas).padStart(12)} │ ${r.wallMs.toFixed(1).padStart(8)} │ ${r.perDeltaUs.toFixed(2).padStart(11)} │`,
      );
    }
    console.log('└──────────────────────────────┴──────────────┴──────────┴─────────────┘');
    console.log(
      `\nM1 install: ${installMs.toFixed(1)} ms over ${ROWS} rows = ${((installMs * 1000) / ROWS).toFixed(2)} µs/row (one-time, charged on first touch today)`,
    );
    console.log(
      `bridge share: ${(instrumented.perDeltaUs - bridgeless.perDeltaUs).toFixed(2)} µs/delta · mobx setter share: ${(bridgeless.perDeltaUs - cold.perDeltaUs).toFixed(2)} µs/delta · base apply: ${cold.perDeltaUs.toFixed(2)} µs/delta\n`,
    );
  }, 120_000);

  it('decomposes CREATE construction apply (run 47: the CREATE/MIXED drain owner)', () => {
    // The bench observer's exact shape: fresh rows stream in against the
    // 10k default cap, so eviction runs continuously once the pool fills.
    const atCap = runAddScenario('add at 10k cap (observer)', { maxSize: 10_000 });
    const uncapped = runAddScenario('add uncapped', { maxSize: FRAMES * FRAME_DELTAS + WARMUP_FRAMES * FRAME_DELTAS + 100 });
    const noWeakRef = runAddScenario('add uncapped, weakrefs off', {
      maxSize: FRAMES * FRAME_DELTAS + WARMUP_FRAMES * FRAME_DELTAS + 100,
      useWeakRefs: false,
    });

    // Construction alone: createFromData without the pool insert.
    const { pool } = setup2({ maxSize: 100 });
    const frames = Array.from({ length: FRAMES }, (_, i) => addFrame(i + 1000));
    const constructStart = performance.now();
    let built = 0;
    for (const frame of frames) {
      for (const delta of frame) {
        const model = pool.createFromData(
          { ...(delta.data as Record<string, unknown>), __typename: 'Item' },
          undefined,
          { deferObservability: true },
        );
        if (model) built++;
      }
    }
    const constructMs = performance.now() - constructStart;
    clearActiveRegistry();
    expect(built).toBe(FRAMES * FRAME_DELTAS);
    const constructPerDeltaUs = (constructMs * 1000) / built;

    const rows = [atCap, uncapped, noWeakRef];
    console.log('\n┌──────────────────────────────┬──────────────┬──────────┬─────────────┐');
    console.log('│ scenario                     │ deltas       │  wallMs  │ per-delta µs│');
    console.log('├──────────────────────────────┼──────────────┼──────────┼─────────────┤');
    for (const r of rows) {
      console.log(
        `│ ${r.scenario.padEnd(28)} │ ${String(r.totalDeltas).padStart(12)} │ ${r.wallMs.toFixed(1).padStart(8)} │ ${r.perDeltaUs.toFixed(2).padStart(11)} │`,
      );
    }
    console.log(
      `│ ${'construct only (no insert)'.padEnd(28)} │ ${String(built).padStart(12)} │ ${constructMs.toFixed(1).padStart(8)} │ ${constructPerDeltaUs.toFixed(2).padStart(11)} │`,
    );
    console.log('└──────────────────────────────┴──────────────┴──────────┴─────────────┘');
    console.log(
      `\neviction share: ${(atCap.perDeltaUs - uncapped.perDeltaUs).toFixed(2)} µs/delta · weakref/size-probe share: ${(uncapped.perDeltaUs - noWeakRef.perDeltaUs).toFixed(2)} µs/delta · insert bookkeeping: ${(noWeakRef.perDeltaUs - constructPerDeltaUs).toFixed(2)} µs/delta · construction: ${constructPerDeltaUs.toFixed(2)} µs/delta\n`,
    );
  }, 240_000);
});
