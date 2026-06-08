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
import type { SyncStoreContract } from '../react/context.js';
import { createTransaction, type Transaction } from './Transaction.js';
import { type InverseOp, type UndoEntry, parseUndoEntry } from './inverseOp.js';
import {
  resolveOps,
  DEFAULT_UNDO_CONFLICT_POLICY,
  type UndoConflictPolicy,
} from './undoApply.js';

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
}

/**
 * A single undo stack for one surface. Access via `UndoManager.getScope(name)`.
 * Consumers call `record(entry)` after each mutator; `undo()` / `redo()` to
 * traverse the stacks.
 */
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

  constructor(
    private readonly schema: S,
    private readonly store: SyncStoreContract,
    private readonly organizationId: string,
    options: UndoScopeOptions = {},
  ) {
    this.maxHistory = options.maxHistory ?? 100;
    this.conflictPolicy = options.conflictPolicy ?? DEFAULT_UNDO_CONFLICT_POLICY;
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
   * `useMutators` calls this so the snapshot → write → `record()` sequence is
   * atomic relative to other invocations, undo, and redo.
   */
  runRecorded<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(work);
  }

  /**
   * Internal: record a mutator's inverses. Clears the redo stack.
   *
   * Entries here are produced internally by `RecordingTransaction` (trusted),
   * so the schema check is DEV-ONLY: it catches recorder bugs in dev/test
   * (rejecting a malformed op at ingestion, with its path, instead of letting
   * it crash later inside `applyOps`) without paying a Zod parse on every user
   * action in production. The real validation boundary is `parseUndoEntry`,
   * applied when entries are deserialized from persistence (untrusted input).
   * Best practice: validate at trust boundaries, type-check internal calls.
   */
  record(entry: UndoEntry): void {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      parseUndoEntry(entry);
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
    this.emitRecord(entry);
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
      await applyOps(tx, ops);
      this.redoStack.push(entry);
      if (this.redoStack.length > this.maxHistory) this.redoStack.shift();
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
      await applyOps(tx, ops);
      this.undoStack.push(entry);
      if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    });
  }

  /** Drop all history. Use after bootstrap / sync group change / sync error. */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Introspection — for debug panels / e2e tests. */
  size(): { undo: number; redo: number } {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
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
