/**
 * Captures a {@link Snapshot} of a chosen set of entities, along with a
 * watermark, so a caller can detect when that state has gone stale. This is
 * what an LLM caller threads into a prompt: `stamp` flows into later writes as
 * `readAt`, so the server rejects a mutation premised on data that has since
 * changed; `signal` is an `AbortSignal` that fires as soon as any captured
 * entity receives a delta, so a mid-generation invalidation can abort the token
 * stream instead of producing output against stale context.
 *
 * It reads the current entity state from the in-memory pool, reads the engine's
 * current `lastSyncId` as the watermark, and subscribes to delta frames on the
 * existing sync connection — no second connection.
 */

import type { InstanceCache } from '../InstanceCache.js';
import type { Schema } from '../schema/schema.js';
import type { SyncDelta, SyncWebSocket } from './SyncWebSocket.js';
import type {
  ContextChange,
  Snapshot,
} from '../types/streams.js';
import { AbloValidationError } from '../errors.js';
import { Model, modelAsRow } from '../Model.js';

/**
 * The snapshot result exposes `stamp`, `signal`, and `onChange` at its top
 * level, alongside one bucket per model. If a schema declares a model with one
 * of these names, the two would collide, so snapshot creation throws instead.
 */
const RESERVED_SNAPSHOT_KEYS: ReadonlySet<string> = new Set([
  'stamp',
  'signal',
  'onChange',
]);

export interface CreateSnapshotArgs<
  TSchema extends Schema = Schema,
  K extends keyof TSchema['models'] & string = keyof TSchema['models'] & string,
> {
  pool: InstanceCache;
  /** Live transport for delta subscriptions. May be null if the engine
   *  hasn't connected yet — the snapshot still resolves with current
   *  pool state, but `signal` won't fire until reconnect. */
  transport: SyncWebSocket | null;
  /** Returns the engine's current `lastSyncId`. Read at snapshot time
   *  to stamp the watermark; not re-read after. */
  getLastSyncId: () => number;
  entities: Readonly<Record<K, string | readonly string[]>>;
}

export function createSnapshot<
  TSchema extends Schema,
  K extends keyof TSchema['models'] & string,
>(args: CreateSnapshotArgs<TSchema, K>): Snapshot<TSchema, K> {
  const { pool, transport, getLastSyncId, entities } = args;

  // ── Validate keys ────────────────────────────────────────────────
  for (const key of Object.keys(entities)) {
    if (RESERVED_SNAPSHOT_KEYS.has(key)) {
      throw new AbloValidationError(
        `engine.snapshot: model key "${key}" collides with a reserved ` +
          `snapshot field (stamp / signal / onChange). Rename the model ` +
          'in your schema.',
        { code: 'snapshot_reserved_key' },
      );
    }
  }

  // ── Watermark ────────────────────────────────────────────────────
  const stamp = getLastSyncId();

  // ── Capture data + watched set ───────────────────────────────────
  const watched = new Set<string>(); // `${type}:${id}`
  const data: Record<string, Record<string, unknown>> = {};

  for (const [type, idOrIds] of Object.entries(entities)) {
    const ids = Array.isArray(idOrIds)
      ? (idOrIds as readonly string[])
      : [idOrIds as string];
    const bucket: Record<string, unknown> = {};
    for (const id of ids) {
      const m = pool.get(id);
      // Only include if the model actually has the requested type —
      // pool keys models globally by id, so `pool.get(id)` could
      // return a different model that happens to share the id (rare,
      // but type guards keep the surface honest).
      if (m && m instanceof Model && m.getModelName() === type) {
        bucket[id] = modelAsRow(m);
      }
      watched.add(`${type}:${id}`);
    }
    data[type] = bucket;
  }

  // ── Invalidation wiring ──────────────────────────────────────────
  const listeners = new Set<(change: ContextChange) => void>();
  const controller = new AbortController();

  const fireChange = (change: ContextChange) => {
    if (!controller.signal.aborted) {
      controller.abort(
        new Error(
          'snapshot invalidated — underlying entity received a delta',
        ),
      );
    }
    for (const l of listeners) {
      try {
        l(change);
      } catch {
        /* listener errors don't break siblings */
      }
    }
  };

  let unsubDelta: (() => void) | null = null;
  if (transport) {
    unsubDelta = transport.subscribe('delta', (delta: SyncDelta) => {
      const key = `${delta.modelName}:${delta.modelId}`;
      if (!watched.has(key)) return;
      // Every delta to a captured entity is reported as 'semantic' severity.
      fireChange({
        model: delta.modelName,
        id: delta.modelId,
        severity: 'semantic',
      });
    });
  }

  // ── Build the flat result ────────────────────────────────────────
  const result: Record<string, unknown> = {
    stamp,
    signal: controller.signal,
    onChange: (listener: (change: ContextChange) => void) => {
      listeners.add(listener);
      // The caller unsubscribes its own listener via the returned function.
      // The underlying delta subscription lives for the snapshot's lifetime;
      // there is no explicit dispose because a snapshot is short-lived (one
      // LLM call's worth) and the subscription is cheap.
      return () => {
        listeners.delete(listener);
        // Once the last listener is gone and the abort has fired, drop the
        // delta subscription too — nothing is listening anymore.
        if (listeners.size === 0 && controller.signal.aborted && unsubDelta) {
          unsubDelta();
          unsubDelta = null;
        }
      };
    },
  };
  for (const [modelName, bucket] of Object.entries(data)) {
    result[modelName] = bucket;
  }

  // Dynamic-shape boundary — `result` is built at runtime by iterating
  // schema-derived buckets, so it structurally satisfies
  // `Snapshot<TSchema, K>`. TS can't prove the static cast, but the
  // runtime invariant holds.
  return result as unknown as Snapshot<TSchema, K>;
}
