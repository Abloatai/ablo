/**
 * UndoManager — per-scope history of reversible mutations.
 *
 * Each mutator invocation records an ordered list of inverse operations.
 * On `undo()` we pop the last group and apply the inverses as a non-recorded
 * transaction (so the inverse itself doesn't push to the redo stack; we do
 * that explicitly below).
 *
 * Scopes: every consumer (deck editor, spreadsheet, etc.) gets a named scope
 * via `getScope(name)`. Cmd+Z in one surface never affects another.
 *
 * V1 limitations:
 *   - No persistence across sessions (in-memory stack).
 *   - No collaborative awareness — undoing after a teammate edited the same
 *     row produces a "last writer wins" outcome, not a true merge.
 *   - Server-side mutation rejection after optimistic apply does NOT
 *     automatically invalidate the undo stack. Consumers should `clear()`
 *     the scope on sync error if they want strict correctness.
 */

import type { Schema } from '../schema/schema.js';
import type { SyncStoreContract, LocalMutation } from '../react/context.js';
import { createTransaction, type Transaction } from './Transaction.js';
import { type InverseOp, type UndoEntry, parseUndoEntry } from './inverseOp.js';
import {
  resolveOps,
  DEFAULT_UNDO_CONFLICT_POLICY,
  type UndoConflictPolicy,
} from './undoApply.js';

/** Normalize a registered model name to the queue's lowercased alias form
 * (mirrors TransactionQueue's `normalizeModelKey`). */
const normalizeModelAlias = (modelName: string): string =>
  modelName.replace('Model', '').toLowerCase();

// ── Inverse op model ──────────────────────────────────────────────────────
//
// The `InverseOp` / `UndoEntry` shapes and their validator live in
// `./inverseOp.ts` as Zod schemas (single source of truth). Re-exported here
// so existing consumers (and the `Ablo.Mutator.*` namespace) keep importing
// them from the undo manager.
export type { InverseOp, UndoEntry };
export type { UndoConflictPolicy } from './undoApply.js';

// ── Scope ──────────────────────────────────────────────────────────────────

export interface UndoScopeOptions {
  /** Max number of undo entries. Older entries drop off the bottom. Default: 100. */
  maxHistory?: number;
  /**
   * How undo/redo treats a field a collaborator changed after your op.
   * Default `skip-stale` — your undo reverts your change only where it still
   * stands, never clobbering a concurrent collaborator edit (per-user undo).
   * `last-writer-wins` restores the legacy clobbering behavior. See
   * {@link UndoConflictPolicy}.
   */
  conflictPolicy?: UndoConflictPolicy;
  /**
   * Which models this surface owns. The scope only records mutations whose
   * resolved schema key passes this predicate, so a spreadsheet edit never
   * lands on the deck editor's stack (the equivalent of Yjs scoping by
   * shared-type set). Omit to track every model — fine for a single-surface
   * app, wrong when two surfaces with independent Cmd+Z share one store.
   */
  tracksModel?: (schemaKey: string) => boolean;
  /**
   * Opt into recording undo entries by OBSERVING the local-mutation stream
   * (the best-practice model: undo listens where all local writes converge —
   * Yjs/Liveblocks). When false (default), the scope records nothing on its
   * own and relies on legacy manual `record()` calls. Transitional: a scope
   * must not mix the two, or shared writes double-count. Flip a surface to
   * `true` only when its manual-record consumers are removed in the same step.
   */
  recordFromStream?: boolean;
}

/**
 * A single undo stack for one surface. Access via `UndoManager.getScope(name)`.
 * Consumers call `record(entry)` after each mutator; `undo()` / `redo()` to
 * traverse the stacks.
 */
/**
 * How long a marked replay-echo stays armed before it's pruned. The real echo
 * arrives within a couple of IndexedDB round-trips (tens of ms); this is a
 * generous safety ceiling so a never-arriving echo (e.g. the commit was skipped
 * offline) can't suppress a genuine later edit to the same row indefinitely.
 */
const REPLAY_ECHO_TTL_MS = 5000;

export class UndoScope<S extends Schema> {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private readonly maxHistory: number;
  private readonly conflictPolicy: UndoConflictPolicy;

  /**
   * Observers notified after each successful {@link record}. These see FORWARD
   * user actions only — `undo()`/`redo()` replays move entries between stacks
   * without calling `record()`, so a listener never observes a reversal. This
   * is a deliberately domain-agnostic seam: analytics, gamification, and audit
   * can tap the committed-mutation stream without the scope knowing about them.
   * A throwing listener is isolated (see {@link emitRecord}) so a faulty
   * observer can never wedge the editor's recording path.
   */
  private readonly recordListeners = new Set<(entry: UndoEntry) => void>();

  /**
   * Observers notified after ANY stack change — record, undo, redo, or clear.
   * Distinct from {@link recordListeners} (forward actions only): this fires on
   * reversals too, so React consumers can keep `canUndo`/`canRedo` live. The
   * stream-recording path pushes entries WITHOUT a React render, so without this
   * a freshly-recorded entry leaves `canUndo` stale (snapshot from last render)
   * and a Cmd+Z handler gated on `canUndo !== false` silently no-ops.
   */
  private readonly changeListeners = new Set<() => void>();

  /**
   * Serialization tail. Recording, undo, and redo all chain off this single
   * promise so they run strictly in the order they were *invoked* — never
   * interleaved. This is load-bearing for correctness, not just throughput:
   *   - Ordering: callers fire writes un-awaited (`void mutations.x.update`).
   *     Without serialization, an entry lands on the stack when its mutator
   *     *resolves*, so a fast second write can record before a slow first one
   *     → undo replays in the wrong order.
   *   - Snapshot integrity: every recording reads/clears the shared models'
   *     `modifiedProperties` (the undo "before" baseline). Two recordings
   *     interleaving on the same model corrupt each other's inverse snapshot.
   * Serializing the whole scope closes both holes with one mechanism.
   */
  private tail: Promise<unknown> = Promise.resolve();

  /** Predicate selecting which models this surface records (see options). */
  private readonly tracksModel?: (schemaKey: string) => boolean;
  /** registered-name / alias → schema key, built once from the schema. */
  private readonly schemaKeyByAlias = new Map<string, string>();
  /** Unsubscribe from the local-mutation stream. */
  private readonly unsubscribe: () => void;
  /**
   * True while `undo()`/`redo()` replays ops. Replays write through the same
   * commit path, so they re-emit on the local-mutation stream; this flag tells
   * our own listener to ignore them (no echo) — the engine equivalent of Yjs's
   * `trackedOrigins` exclusion / Liveblocks pausing history during undo.
   */
  private replaying = false;
  /** Ops collected during the current tick, flushed as ONE entry. */
  private batch: Array<{ forward: InverseOp; inverse: InverseOp | null }> = [];
  private flushScheduled = false;
  /**
   * Open grouping session (Liveblocks `history.pause()` / Yjs `stopCapturing`
   * analogue). While set, stream ops accumulate here ACROSS ticks instead of
   * flushing per-tick, so a multi-tick action (a drag, a whole streaming AI
   * response) collapses into ONE Cmd+Z. `endGroup()` flushes it.
   */
  private group: { label?: string; ops: Array<{ forward: InverseOp; inverse: InverseOp | null }> } | null =
    null;
  /**
   * ASYNC replay-echo suppression, keyed by `${modelKey}:${id}`.
   *
   * The synchronous {@link replaying} flag only catches echoes delivered INLINE
   * during `applyOps`. The real engine doesn't emit `transaction:created`
   * synchronously: `SyncClient` defers the commit behind `scheduleSync()` +
   * `await persistMutationQueue()` (an IndexedDB write), so a replayed write's
   * echo lands on the stream AFTER `undo()`/`redo()` has already reset
   * `replaying` and pushed the entry. That late echo would be recorded as a
   * NEW edit — and `record()` clears the redo stack, so every undo silently
   * destroyed its own redo. We mark the (modelKey,id) of every op we're about
   * to replay here (synchronously, before the write), and consume one mark when
   * the matching mutation arrives — independent of WHEN it arrives. Entries
   * carry a TTL so a never-arriving echo (offline: the commit is skipped) can't
   * leak and wrongly suppress a much-later genuine edit to the same row.
   */
  private readonly pendingReplayEchoes = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly schema: S,
    private readonly store: SyncStoreContract,
    private readonly organizationId: string,
    options: UndoScopeOptions = {},
  ) {
    this.maxHistory = options.maxHistory ?? 100;
    this.conflictPolicy = options.conflictPolicy ?? DEFAULT_UNDO_CONFLICT_POLICY;
    this.tracksModel = options.tracksModel;

    // Build the registered-name → schema-key alias map. The mutation stream
    // reports `model.getModelName()` (e.g. `'SlideLayer'`), but inverse ops
    // and the replay transaction are keyed by the SCHEMA key (e.g.
    // `'slideLayers'`). Map every reasonable spelling to the schema key.
    for (const schemaKey of Object.keys(this.schema.models)) {
      const def = (this.schema.models as Record<string, { typename?: string }>)[schemaKey];
      const typename = def?.typename ?? schemaKey;
      for (const alias of [schemaKey, typename]) {
        this.schemaKeyByAlias.set(alias, schemaKey);
        this.schemaKeyByAlias.set(alias.toLowerCase(), schemaKey);
        this.schemaKeyByAlias.set(normalizeModelAlias(alias), schemaKey);
      }
    }

    // Subscribe to the local-mutation stream ONLY when this scope opts into
    // stream recording. Transitional flag: surfaces still on the legacy
    // manual-record path (mutator `RecordingTransaction`, AI pipeline
    // sessions) keep `recordFromStream: false` so writes aren't double-counted.
    // Once every surface is migrated, stream recording becomes the only path
    // and the flag is removed. Optional on the contract so minimal test
    // doubles can omit it (undo then records nothing).
    this.unsubscribe =
      options.recordFromStream && this.store.subscribeLocalMutations
        ? this.store.subscribeLocalMutations((m) => this.onLocalMutation(m))
        : () => {};
  }

  /**
   * Open a grouping session: every stream-recorded op until {@link endGroup}
   * collapses into a single undo entry. Mirrors Liveblocks `history.pause()` —
   * call on gesture start (pointerdown) or AI-response start. Idempotent-ish:
   * a second call closes the previous group first.
   */
  beginGroup(label?: string): void {
    if (this.group) this.endGroup();
    this.group = { label, ops: [] };
  }

  /** Close the grouping session and record the accumulated ops as one entry. */
  endGroup(label?: string): void {
    const g = this.group;
    if (!g) return;
    this.group = null;
    const forwards = g.ops.map((c) => c.forward);
    const inverses = g.ops
      .map((c) => c.inverse)
      .filter((i): i is InverseOp => i !== null)
      .reverse();
    if (forwards.length === 0 && inverses.length === 0) return;
    this.record({ label: label ?? g.label, inverses, forwards });
  }

  /** Every `${modelKey}:${id}` a set of ops will touch (all op kinds). */
  private *replayEchoKeys(ops: InverseOp[]): Iterable<string> {
    for (const op of ops) {
      switch (op.kind) {
        case 'create': {
          const id = op.data.id;
          if (typeof id === 'string') yield `${op.modelKey}:${id}`;
          break;
        }
        case 'update':
          yield `${op.modelKey}:${op.patch.id}`;
          break;
        case 'delete':
          yield `${op.modelKey}:${op.id}`;
          break;
        case 'createMany':
          for (const d of op.data) {
            const id = d.id;
            if (typeof id === 'string') yield `${op.modelKey}:${id}`;
          }
          break;
        case 'updateMany':
          for (const p of op.patches) yield `${op.modelKey}:${p.id}`;
          break;
        case 'deleteMany':
          for (const id of op.ids) yield `${op.modelKey}:${id}`;
          break;
      }
    }
  }

  /**
   * Arm async-echo suppression for the rows a replay is about to write. Called
   * synchronously, before `applyOps`, so the marks exist no matter how long the
   * engine takes to surface the echo on the stream. See {@link pendingReplayEchoes}.
   */
  private markReplayEchoes(ops: InverseOp[]): void {
    const expiresAt = Date.now() + REPLAY_ECHO_TTL_MS;
    for (const key of this.replayEchoKeys(ops)) {
      const existing = this.pendingReplayEchoes.get(key);
      if (existing) {
        existing.count += 1;
        existing.expiresAt = expiresAt;
      } else {
        this.pendingReplayEchoes.set(key, { count: 1, expiresAt });
      }
    }
  }

  /**
   * If `${schemaKey}:${modelId}` has an armed echo mark, consume one and report
   * that this mutation is our own replay echo (caller drops it). Prunes expired
   * marks opportunistically so a skipped/never-arriving echo can't leak.
   */
  private consumeReplayEcho(schemaKey: string, modelId: string): boolean {
    if (this.pendingReplayEchoes.size === 0) return false;
    const now = Date.now();
    for (const [k, v] of this.pendingReplayEchoes) {
      if (v.expiresAt <= now) this.pendingReplayEchoes.delete(k);
    }
    const key = `${schemaKey}:${modelId}`;
    const pending = this.pendingReplayEchoes.get(key);
    if (!pending) return false;
    pending.count -= 1;
    if (pending.count <= 0) this.pendingReplayEchoes.delete(key);
    return true;
  }

  /** Resolve a stream mutation's registered name to its schema key, or null. */
  private resolveSchemaKey(modelName: string): string | null {
    return (
      this.schemaKeyByAlias.get(modelName) ??
      this.schemaKeyByAlias.get(normalizeModelAlias(modelName)) ??
      null
    );
  }

  /**
   * Stream listener — the sole place entries are born. Skips replay echoes
   * and out-of-scope models, derives the forward+inverse op from the
   * mutation's `data`/`previousData`, and defers the stack push to a
   * per-tick flush so a burst of writes (e.g. align 5 layers) becomes ONE
   * undo step — riding the same tick boundary the TransactionQueue batches on.
   */
  private onLocalMutation(m: LocalMutation): void {
    if (this.replaying) return;
    const schemaKey = this.resolveSchemaKey(m.modelName);
    if (!schemaKey) return;
    // Drop the ASYNC echo of our own replayed writes. The engine surfaces a
    // replay's `transaction:created` only after an IndexedDB-gated commit, i.e.
    // after `replaying` has already reset — so the synchronous flag above misses
    // it. The (modelKey,id) marks armed in `markReplayEchoes` catch it whenever
    // it lands, which is what stops every undo from wiping its own redo stack.
    if (this.consumeReplayEcho(schemaKey, m.modelId)) return;
    if (this.tracksModel && !this.tracksModel(schemaKey)) return;

    const ops = buildUndoOps(m, schemaKey);
    if (!ops) return;

    // Inside a grouping session, accumulate across ticks (flushed on
    // endGroup); otherwise coalesce per-tick.
    if (this.group) {
      this.group.ops.push(ops);
      return;
    }
    this.batch.push(ops);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = () => {
      this.flushScheduled = false;
      this.flushBatch();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else void Promise.resolve().then(run);
  }

  /** Coalesce the tick's collected ops into one entry and record it. */
  private flushBatch(): void {
    if (this.batch.length === 0) return;
    const collected = this.batch;
    this.batch = [];
    const forwards = collected.map((c) => c.forward);
    // Undo applies inverses in REVERSE order of how the forwards ran.
    const inverses = collected
      .map((c) => c.inverse)
      .filter((i): i is InverseOp => i !== null)
      .reverse();
    if (forwards.length === 0 && inverses.length === 0) return;
    this.record({ inverses, forwards });
  }

  /**
   * Run `work` after every previously-enqueued scope operation has settled,
   * in invocation order. The internal `tail` always resolves (failures are
   * swallowed *for the chain only*) so one rejected mutator can't wedge the
   * queue; the original settlement is still surfaced to this call's caller.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Run a recording mutator exclusively on the scope's serialization chain.
   * Used by the legacy manual-record path (`useMutators` + `RecordingTransaction`)
   * so the snapshot → write → `record()` sequence is atomic relative to undo/
   * redo. The stream-recording path doesn't need this (it derives entries from
   * already-committed mutations); kept until all surfaces migrate off manual.
   */
  runRecorded<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(work);
  }

  /**
   * Record one entry onto the undo stack. Clears the redo stack. Fed by
   * {@link flushBatch}/{@link endGroup} from the local-mutation stream, and
   * still called directly by the legacy manual-record consumers
   * (`useMutators`, the AI mutation pipeline) until they migrate. Entries are
   * built internally (trusted), so the schema check is DEV-ONLY: it catches
   * recorder bugs in dev/test (rejecting a malformed op at ingestion, with its
   * path, instead of letting it crash later inside `applyOps`) without paying a
   * Zod parse on every user action in production. The real validation boundary
   * is `parseUndoEntry`, applied when entries are deserialized from persistence
   * (untrusted input). Best practice: validate at trust boundaries, type-check
   * internal calls.
   */
  record(entry: UndoEntry): void {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      parseUndoEntry(entry);
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
    this.emitRecord(entry);
    this.emitChange();
  }

  /**
   * Subscribe to every recorded mutation. Fires synchronously at the tail of
   * each {@link record} call, after the entry is on the undo stack. Returns an
   * unsubscribe function — call it on teardown.
   *
   * Listeners receive the full {@link UndoEntry} (its `forwards` carry the
   * `{ kind, modelKey, data }` ops), so a consumer can derive what changed
   * (e.g. "a slideLayers row of type 'chart' was created") without re-querying.
   */
  onRecord(listener: (entry: UndoEntry) => void): () => void {
    this.recordListeners.add(listener);
    return () => {
      this.recordListeners.delete(listener);
    };
  }

  private emitRecord(entry: UndoEntry): void {
    for (const listener of this.recordListeners) {
      try {
        listener(entry);
      } catch (err) {
        // A faulty observer must never break the editor's recording path.
        if (typeof console !== 'undefined') {
          console.error('[UndoScope] onRecord listener threw', err);
        }
      }
    }
  }

  /**
   * Subscribe to ANY stack change (record/undo/redo/clear). Used by
   * `useUndoScope` to re-render so `canUndo`/`canRedo` stay live across every
   * consumer — not just the component that invoked undo/redo. Returns an
   * unsubscribe function.
   */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        if (typeof console !== 'undefined') {
          console.error('[UndoScope] onChange listener threw', err);
        }
      }
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Pop the last mutator and apply its inverses. Pushes to redo.
   *
   * Under the default `skip-stale` policy the inverses are filtered against
   * live state first (paired with the entry's forwards = "what I set"), so a
   * field a collaborator changed after my op is left untouched — undo reverts
   * my change only where it still stands.
   */
  undo(): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.undoStack.pop();
      if (!entry) return;
      const tx = createTransaction(this.schema, this.store, this.organizationId);
      const ops = resolveOps(entry.inverses, entry.forwards, this.store, this.conflictPolicy);
      // Suppress our own stream listener so replayed writes don't record as
      // new undo entries. `replaying` covers inline echoes; `markReplayEchoes`
      // covers the engine's async (IDB-gated) echo that lands after this method
      // returns. Cleared in `finally` even if a replay op throws.
      this.markReplayEchoes(ops);
      this.replaying = true;
      try {
        await applyOps(tx, ops);
      } catch (err) {
        // The replay was rejected (e.g. a server 409): the world didn't change,
        // so restore the entry to the undo stack rather than silently dropping
        // it (which would also strand it off the redo stack — invisible undo).
        this.undoStack.push(entry);
        this.emitChange();
        throw err;
      } finally {
        this.replaying = false;
      }
      this.redoStack.push(entry);
      if (this.redoStack.length > this.maxHistory) this.redoStack.shift();
      this.emitChange();
    });
  }

  /**
   * Pop the last undone entry and re-apply the forward ops. Pushes to undo.
   * Symmetric to {@link undo}: forwards are filtered against live state
   * (paired with the entry's inverses = "what undo restored"), so redo
   * re-asserts my change only where the undone value still stands.
   */
  redo(): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.redoStack.pop();
      if (!entry) return;
      const tx = createTransaction(this.schema, this.store, this.organizationId);
      const ops = resolveOps(entry.forwards, entry.inverses, this.store, this.conflictPolicy);
      // See undo(): arm async-echo suppression before the replayed writes.
      this.markReplayEchoes(ops);
      this.replaying = true;
      try {
        await applyOps(tx, ops);
      } catch (err) {
        // Symmetric to undo: a rejected re-apply leaves state unchanged, so put
        // the entry back on the redo stack instead of losing it.
        this.redoStack.push(entry);
        this.emitChange();
        throw err;
      } finally {
        this.replaying = false;
      }
      this.undoStack.push(entry);
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
      this.emitChange();
    });
  }

  /** Drop all history. Use after bootstrap / sync group change / sync error. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.batch = [];
    this.pendingReplayEchoes.clear();
    this.emitChange();
  }

  /** Introspection — for debug panels / e2e tests. */
  size(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }

  /**
   * Detach from the local-mutation stream and drop listeners. Scopes are
   * cached for the store's lifetime by `UndoManager`, so this is mainly for
   * tests and explicit teardown.
   */
  dispose(): void {
    this.unsubscribe();
    this.recordListeners.clear();
    this.changeListeners.clear();
    this.batch = [];
    this.pendingReplayEchoes.clear();
  }
}

/**
 * Derive the forward + inverse op for a single local mutation. Returns null
 * when the mutation can't be reversed (e.g. an update with no captured
 * previous values), so the caller can drop it rather than push a half-entry.
 */
function buildUndoOps(
  m: LocalMutation,
  modelKey: string,
): { forward: InverseOp; inverse: InverseOp | null } | null {
  const id = m.modelId;
  const stripId = (o?: Record<string, unknown> | null): Record<string, unknown> => {
    const out = { ...(o ?? {}) };
    delete out.id;
    return out;
  };

  switch (m.type) {
    case 'create':
      return {
        forward: { kind: 'create', modelKey, data: { ...stripId(m.data), id } },
        inverse: { kind: 'delete', modelKey, id },
      };
    case 'update': {
      const next = stripId(m.data);
      const prev = stripId(m.previousData);
      return {
        forward: { kind: 'update', modelKey, patch: { id, ...next } },
        // No previous values captured → not reversible; drop the inverse.
        inverse:
          Object.keys(prev).length > 0
            ? { kind: 'update', modelKey, patch: { id, ...prev } }
            : null,
      };
    }
    case 'delete':
      return {
        forward: { kind: 'delete', modelKey, id },
        inverse: { kind: 'create', modelKey, data: { ...stripId(m.previousData), id } },
      };
    case 'archive':
      return {
        forward: { kind: 'update', modelKey, patch: { id, archivedAt: new Date() } },
        inverse: { kind: 'update', modelKey, patch: { id, archivedAt: null } },
      };
    case 'unarchive':
      return {
        forward: { kind: 'update', modelKey, patch: { id, archivedAt: null } },
        inverse: { kind: 'update', modelKey, patch: { id, archivedAt: new Date() } },
      };
    default:
      return null;
  }
}

// ── Manager ────────────────────────────────────────────────────────────────

/**
 * Central registry of named undo scopes. One per-app instance, created once
 * during engine setup. Mutator invocations find their scope by name.
 */
export class UndoManager<S extends Schema> {
  private readonly scopes = new Map<string, UndoScope<S>>();

  constructor(
    private readonly schema: S,
    private readonly store: SyncStoreContract,
    private readonly organizationId: string,
  ) {}

  getScope(name: string, options?: UndoScopeOptions): UndoScope<S> {
    let scope = this.scopes.get(name);
    if (!scope) {
      scope = new UndoScope(this.schema, this.store, this.organizationId, options);
      this.scopes.set(name, scope);
    }
    return scope;
  }

  clearAll(): void {
    for (const scope of this.scopes.values()) scope.clear();
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Replay a list of InverseOps through a Transaction. Used by both undo
 * (replaying captured inverses) and redo (replaying the captured forwards).
 * Every op is awaited sequentially to preserve ordering guarantees.
 */
async function applyOps<S extends Schema>(tx: Transaction<S>, ops: InverseOp[]): Promise<void> {
  // The tx.mutations is a Proxy whose per-key methods are strongly typed from
  // the schema. Inverse ops are persisted as plain JSON-shaped data, so we
  // cross the boundary with a single cast to the generic mutate signature
  // used by the replay machinery. `create`/`update`/`delete` are overloaded
  // to accept single or array — the array-shaped InverseOp kinds
  // (`createMany`/`updateMany`/`deleteMany`) dispatch through the same
  // method names with array arguments.
  type Mutators = Record<
    string,
    {
      create: (data: Record<string, unknown> | Record<string, unknown>[]) => Promise<unknown>;
      update: (
        patch:
          | ({ id: string } & Record<string, unknown>)
          | Array<{ id: string } & Record<string, unknown>>,
      ) => Promise<unknown>;
      delete: (id: string | string[]) => Promise<void>;
    }
  >;
  const mutateAny = tx.mutations as unknown as Mutators;

  for (const op of ops) {
    const m = mutateAny[op.modelKey];
    switch (op.kind) {
      case 'create':
        await m.create(op.data);
        break;
      case 'update':
        await m.update(op.patch);
        break;
      case 'delete':
        await m.delete(op.id);
        break;
      case 'createMany':
        await m.create(op.data);
        break;
      case 'updateMany':
        await m.update(op.patches);
        break;
      case 'deleteMany':
        await m.delete(op.ids);
        break;
    }
  }
}
