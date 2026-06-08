/**
 * Engine-attached snapshot factory.
 *
 * Captures the engine's current entity state + watermark for context-
 * staleness detection. The returned Snapshot is what an LLM caller
 * threads into a prompt: `stamp` flows into writes as `readAt` so the
 * server rejects mutations against now-stale data; `signal` fires on
 * any captured-entity delta so mid-generation invalidations abort
 * the token stream rather than producing output against dead context.
 *
 * Reads from the engine's MobX-reactive ObjectPool, picks up the
 * engine's `lastSyncId`, and subscribes to delta frames on the
 * engine's transport. Same socket as entity sync — no second
 * connection.
 */

import type { ObjectPool } from '../ObjectPool.js';
import type { Schema } from '../schema/schema.js';
import type { SyncDelta, SyncWebSocket } from './SyncWebSocket.js';
import type {
  ContextChange,
  Snapshot,
} from '../types/streams.js';
import { AbloValidationError } from '../errors.js';
import { Model, modelAsRow } from '../Model.js';

/**
 * Three top-level keys that conflict with the per-model buckets if a
 * customer's schema declares a model named `stamp` / `signal` /
 * `onChange`. Throw at snapshot time so the collision is loud.
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
  pool: ObjectPool;
  /** Live transport for delta subscriptions. May be null if the engine
   *  hasn't connected yet — the snapshot still resolves with current
   *  pool state, but `signal` won't fire until reconnect. */
  transport: SyncWebSocket | null;
  /** Returns the engine's current `lastSyncId`. Read at snapshot time
   *  to stamp the watermark; not re-read after. */
  getLastSyncId: () => number;
  entities: { readonly [M in K]: string | readonly string[] };
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
      // The snapshot API treats every delta as 'semantic' severity.
      // Future: distinguish metadata-only deltas (e.g., updatedAt
      // bumps) from content changes — that's a separate scope.
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
      // Caller is responsible for unsubscribing when they're done.
      // The delta subscription itself stays for the snapshot's life;
      // there's no public dispose because snapshots are short-lived
      // (one LLM call's worth) and the transport-level subscription
      // is cheap. If a long-lived consumer needs explicit teardown,
      // we can add `.dispose()` in a follow-up.
      return () => {
        listeners.delete(listener);
        // If the last listener AND the abort fired, drop the delta
        // subscription too — no one's listening anymore.
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
