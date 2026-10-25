/**
 * Keeps a per-scope history of reversible changes so a surface can offer undo
 * and redo. Each mutator invocation records an ordered list of inverse
 * operations; `undo()` pops the most recent group and replays those inverses
 * without recording them, then moves the entry onto the redo stack.
 *
 * History is divided into named scopes, one per surface — a report editor, a
 * ledger grid, and so on — reached through {@link UndoManager.getScope}. Undo in
 * one surface never affects another.
 *
 * History lives in memory and does not persist across sessions. A rejected
 * replay retains its group and accepted prefix. An unknown write outcome holds
 * that history for explicit recovery rather than generating another reversal.
 */

import { fieldOperationUndo, reverseFieldOperation, replaceOperationReversals } from '../transactions/operations/index.js';
import { isDefinitiveRejection } from '../transactions/mutations/failurePolicy.js';
import { AbloStaleContextError } from '@abloatai/transaction/errors';
import type { MutationOrigin } from '../transactions/mutations/commitPayload.js';
import type { ModelMetadata } from '@abloatai/transaction/types';
import type { Schema } from '@abloatai/transaction/schema/schema';
import { getContext } from '../context.js';
import type { SyncStoreContract, LocalMutation } from '../storeContract.js';
import { createTransaction, type Transaction } from './Transaction.js';
import { type InverseOp, type UndoEntry, parseUndoEntry } from './inverseOp.js';
import {
  resolveOps,
  DEFAULT_UNDO_CONFLICT_POLICY,
  type UndoConflictPolicy,
} from './undoApply.js';

/** Normalize a registered model name to its lowercased alias form. */
const normalizeModelAlias = (modelName: string): string =>
  modelName.replace('Model', '').toLowerCase();

// ── Inverse op model ──────────────────────────────────────────────────────
//
// The InverseOp and UndoEntry shapes and their validator are defined as Zod
// schemas in `./inverseOp.ts`, and re-exported here so they can be imported
// alongside the undo manager.
export type { InverseOp, UndoEntry };
export type { UndoConflictPolicy } from './undoApply.js';

// ── Scope ──────────────────────────────────────────────────────────────────

export interface UndoScopeOptions {
  /** The maximum number of undo entries to keep. Older entries drop off the
   *  bottom. Defaults to 100. */
  maxHistory?: number;
  /**
   * How undo and redo treat a field a collaborator changed after your own
   * change. The default, `skip-stale`, reverts your change only where it still
   * stands, so undo never overwrites a concurrent edit — undo is per user.
   * `last-writer-wins` restores the older behavior of overwriting regardless. See
   * {@link UndoConflictPolicy}.
   */
  conflictPolicy?: UndoConflictPolicy;
  /**
   * A predicate selecting which models this surface owns. The scope records only
   * mutations whose resolved schema key passes it, so, for example, a ledger
   * edit never lands on a report editor's undo stack. Omit it to track every model,
   * which is fine for a single-surface app but wrong when two surfaces with
   * independent undo share one store.
   */
  tracksModel?: (schemaKey: string) => boolean;
  /**
   * When `true`, the scope records undo entries by observing the stream of local
   * mutations, so every write through the store is captured automatically. When
   * `false`, the default, the scope records nothing on its own and relies on
   * explicit {@link UndoScope.record} calls. Use one mode or the other for a given
   * surface, not both, or shared writes are counted twice.
   */
  recordFromStream?: boolean;
}

/**
 * A single undo stack for one surface, obtained from
 * {@link UndoManager.getScope}. Call {@link UndoScope.record} after a mutator to
 * add an entry, and {@link UndoScope.undo} / {@link UndoScope.redo} to move
 * through the history.
 */
type ReplayOperation = Exclude<InverseOp, { kind: 'createMany' | 'updateMany' | 'deleteMany' }>;
type Reversal = Extract<ReplayOperation, { kind: 'reverse-operation' }>;
interface ReplayProgress {
  remaining: ReplayOperation[];
  reversed: Reversal[];
  completed: number;
  baseline: Map<string, Extract<InverseOp, { kind: 'update' }>>;
  uncertain?: { error: unknown };
}

export class UndoScope<S extends Schema> {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private replayProgress = new WeakMap<UndoEntry, ReplayProgress>();
  private readonly maxHistory: number;
  private readonly conflictPolicy: UndoConflictPolicy;

  /**
   * Observers notified after each successful {@link UndoScope.record}. They see
   * forward user actions only: undo and redo move entries between the stacks
   * without calling `record`, so a listener never observes a reversal. It is a
   * deliberately generic hook — analytics or audit code can watch the stream of
   * committed mutations without the scope knowing about it. A listener that throws
   * is isolated so it cannot break recording.
   */
  private readonly recordListeners = new Set<(entry: UndoEntry) => void>();

  /**
   * Observers notified after any stack change — record, undo, redo, or clear.
   * Unlike {@link recordListeners}, which fires on forward actions only, this
   * fires on reversals too, so a React consumer can keep `canUndo` and `canRedo`
   * current. Because the stream-recording path adds entries without triggering a
   * render, a component that read `canUndo` on its last render would otherwise go
   * stale and a keyboard handler gated on it would quietly do nothing.
   */
  private readonly changeListeners = new Set<() => void>();

  /**
   * The serialization tail. Recording, undo, and redo all chain off this one
   * promise, so they run strictly in the order they were invoked and never
   * interleave. This matters for correctness, not just throughput, in two ways.
   * Ordering: callers often fire writes without awaiting them, so without
   * serialization an entry would land on the stack when its mutator resolves, and
   * a fast second write could record before a slow first — replaying undo in the
   * wrong order. Snapshot integrity: each recording reads and clears a model's
   * modified-field markers, which form the undo baseline, so two recordings
   * interleaving on the same model would corrupt each other's before-image.
   * Serializing the whole scope closes both gaps at once.
   */
  private tail: Promise<unknown> = Promise.resolve();

  /** Predicate selecting which models this surface records (see options). */
  private readonly tracksModel?: (schemaKey: string) => boolean;
  /** registered-name / alias → schema key, built once from the schema. */
  private readonly schemaKeyByAlias = new Map<string, string>();
  /** Unsubscribe from the local-mutation stream. */
  private readonly unsubscribe: () => void;
  private readonly replayOrigin: MutationOrigin = { undoScopeId: crypto.randomUUID() };
  /** Operations collected during the current tick, flushed together as one entry. */
  private batch: { forward: InverseOp; inverse: InverseOp | null }[] = [];
  private flushScheduled = false;
  /**
   * An open grouping session. While set, stream operations accumulate here across
   * ticks instead of flushing each tick, so a multi-tick action — a drag, or a
   * whole streaming AI response — collapses into a single undo step.
   * {@link UndoScope.endGroup} flushes it.
   */
  private group: { label?: string; ops: { forward: InverseOp; inverse: InverseOp | null }[] } | null =
    null;
  constructor(
    private readonly schema: S,
    private readonly store: SyncStoreContract,
    private readonly organizationId: string,
    options: UndoScopeOptions = {},
  ) {
    this.maxHistory = options.maxHistory ?? 100;
    this.conflictPolicy = options.conflictPolicy ?? DEFAULT_UNDO_CONFLICT_POLICY;
    this.tracksModel = options.tracksModel;

    // Build the map from registered name to schema key. The mutation stream
    // reports a model's registered name (for example `'Block'`), but inverse
    // operations and the replay transaction are keyed by the schema key (for
    // example `'blocks'`), so map every reasonable spelling to the schema key.
    for (const schemaKey of Object.keys(this.schema.models)) {
      const def = (this.schema.models as Record<string, { typename?: string }>)[schemaKey];
      const typename = def?.typename ?? schemaKey;
      for (const alias of [schemaKey, typename]) {
        this.schemaKeyByAlias.set(alias, schemaKey);
        this.schemaKeyByAlias.set(alias.toLowerCase(), schemaKey);
        this.schemaKeyByAlias.set(normalizeModelAlias(alias), schemaKey);
      }
    }

    // Subscribe to the local-mutation stream only when this scope opts into
    // stream recording. A scope using explicit `record()` calls instead keeps
    // `recordFromStream` false so writes are not counted twice. The stream method
    // on the store is optional, so a minimal test double can omit it, in which
    // case undo records nothing.
    this.unsubscribe =
      options.recordFromStream && this.store.subscribeLocalMutations
        ? this.store.subscribeLocalMutations((m) => { this.onLocalMutation(m); })
        : () => {};
  }

  /**
   * Opens a grouping session: every stream-recorded operation until
   * {@link UndoScope.endGroup} collapses into one undo entry. Call it at the start
   * of a gesture, such as a pointer-down, or at the start of an AI response. A
   * second call closes the previous group first.
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

  /** Resolve a stream mutation's registered name to its schema key, or null. */
  private resolveSchemaKey(modelName: string): string | null {
    return (
      this.schemaKeyByAlias.get(modelName) ??
      this.schemaKeyByAlias.get(normalizeModelAlias(modelName)) ??
      null
    );
  }

  /**
   * The stream listener, and the only place stream-recorded entries originate. It
   * skips replay echoes and out-of-scope models, derives the forward and inverse
   * operations from the mutation's `data` and `previousData`, and defers the stack
   * push to a per-tick flush, so a burst of writes — aligning five blocks at once,
   * say — becomes a single undo step.
   */
  private onLocalMutation(m: LocalMutation): void {
    const schemaKey = this.resolveSchemaKey(m.modelName);
    if (!schemaKey) return;
    if (m.undoScopeId === this.replayOrigin.undoScopeId) return;
    if (this.tracksModel && !this.tracksModel(schemaKey)) return;

    const ops = buildUndoOps(m, schemaKey, this.schema.models[schemaKey]?.fields);
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
    // Undo applies the inverses in reverse order of how the forwards ran.
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
   * queue; the original confirmation is still surfaced to this call's caller.
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
   * Runs a recording mutator by itself on the scope's serialization chain, so its
   * snapshot, write, and {@link UndoScope.record} happen atomically with respect to
   * undo and redo. This is used by the explicit-record path; the stream-recording
   * path does not need it, since it derives entries from already-committed
   * mutations.
   */
  runRecorded<T>(work: () => Promise<T>): Promise<T> {
    return this.enqueue(work);
  }

  /**
   * Records one entry and clears completed redo history; unresolved partial
   * replays remain available for recovery. It is fed
   * both by the per-tick flush and grouping paths from the local-mutation stream
   * and by direct callers using explicit recording. Entries are built internally
   * and therefore trusted, so the schema check here runs only outside production:
   * it catches recorder bugs early, rejecting a malformed operation at ingestion
   * with a clear path rather than letting it fail later during replay, without
   * paying a validation cost on every user action in production. The real
   * validation boundary is {@link parseUndoEntry}, applied to entries loaded from
   * persistence, which is untrusted input.
   */
  record(entry: UndoEntry): void {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      parseUndoEntry(entry);
    }
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    // A partial or uncertain redo still owns changes and cannot be discarded.
    this.redoStack = this.redoStack.filter((entry) => {
      const progress = this.replayProgress.get(entry);
      return progress && (progress.completed > 0 || progress.uncertain !== undefined);
    });
    this.emitRecord(entry);
    this.emitChange();
  }

  /**
   * Subscribes to every recorded mutation. The listener fires synchronously at the
   * end of each {@link UndoScope.record} call, once the entry is on the undo stack,
   * and the returned function unsubscribes it. The listener receives the full
   * {@link UndoEntry} — its `forwards` carry the `{ kind, modelKey, data }`
   * operations — so a consumer can tell what changed without querying again.
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
        // A faulty observer must never break the recording path. The consumer's
        // own onRecord callback is at fault, so log it as an actionable warning.
        getContext().logger.warn('An undo/redo onRecord listener threw — your callback should not throw', err);
      }
    }
  }

  /**
   * Subscribes to any stack change — record, undo, redo, or clear. The React
   * `useUndoScope` hook uses this to re-render so `canUndo` and `canRedo` stay
   * current for every consumer, not only the component that invoked undo or redo.
   * The returned function unsubscribes.
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
        // The consumer's own onChange callback is at fault, so log it as an
        // actionable warning.
        getContext().logger.warn('An undo/redo onChange listener threw — your callback should not throw', err);
      }
    }
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private async replayEntry(tx: Transaction<S>, entry: UndoEntry, undo: boolean): Promise<Reversal[]> {
    let progress = this.replayProgress.get(entry);
    if (progress?.uncertain) throw new AbloStaleContextError('The previous undo/redo outcome is unknown. Recover its original pending write before clearing this history; no new reversal was submitted.', { code: 'stale_context', cause: progress.uncertain.error });
    if (!progress) {
      const remaining = expandReplayOps(resolveOps(undo ? entry.inverses : entry.forwards,
        undo ? entry.forwards : entry.inverses, this.store, this.conflictPolicy));
      progress = { remaining, reversed: [], completed: 0, baseline: captureReplayBaseline(remaining, this.store) };
      this.replayProgress.set(entry, progress);
    }
    try {
      await applyOps(tx, progress, this.store, this.conflictPolicy, this.replayOrigin);
      this.replayProgress.delete(entry);
      return progress.reversed;
    } catch (error) {
      if (!(error instanceof Error) || !isDefinitiveRejection(error)) progress.uncertain = { error };
      throw error;
    }
  }

  /**
   * Pops the most recent entry, applies its inverse operations, and pushes it onto
   * the redo stack. Under the default `skip-stale` policy the inverses are first
   * filtered against the current state — paired with the entry's forwards, which
   * record what this change set — so a field a collaborator changed afterward is
   * left untouched, and undo reverts the change only where it still stands.
   */
  undo(): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.undoStack.pop();
      if (!entry) return;
      const tx = createTransaction(this.schema, this.store, this.organizationId, this.replayOrigin);
      try {
        const reversed = await this.replayEntry(tx, entry, true);
        entry.forwards = replaceOperationReversals(entry.forwards, reversed);
      } catch (err) {
        // Keep the group and its accepted prefix so retry resumes the remainder.
        this.undoStack.push(entry);
        this.emitChange();
        throw err;
      }
      this.redoStack.push(entry);
      if (this.redoStack.length > this.maxHistory) this.redoStack.shift();
      this.emitChange();
    });
  }

  /**
   * Pops the most recently undone entry, re-applies its forward operations, and
   * pushes it onto the undo stack. It mirrors {@link UndoScope.undo}: the forwards
   * are filtered against the current state — paired with the entry's inverses,
   * which record what undo restored — so redo re-asserts the change only where the
   * undone value still stands.
   */
  redo(): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.redoStack.pop();
      if (!entry) return;
      const tx = createTransaction(this.schema, this.store, this.organizationId, this.replayOrigin);
      try {
        const reversed = await this.replayEntry(tx, entry, false);
        entry.inverses = replaceOperationReversals(entry.inverses, reversed);
      } catch (err) {
        // The rejected suffix remains redoable without repeating its prefix.
        this.redoStack.push(entry);
        this.emitChange();
        throw err;
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
    this.replayProgress = new WeakMap();
    this.batch = [];
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
  }
}

/**
 * Derives the forward and inverse operation for a single local mutation. Returns
 * null when the mutation cannot be reversed — for example, an update with no
 * captured previous values — so the caller drops it rather than push a half-entry.
 */
function buildUndoOps(
  m: LocalMutation,
  modelKey: string,
  fields: ModelMetadata['fields'],
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
      const operationInverse = fieldOperationUndo(modelKey, id, next, prev, fields);
      return {
        forward: { kind: 'update', modelKey, patch: { id, ...next } },
        // No previous values captured → not reversible; drop the inverse.
        inverse: operationInverse ?? (
          Object.keys(prev).length > 0
            ? { kind: 'update', modelKey, patch: { id, ...prev } }
            : null),
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
 * The registry of named undo scopes. One instance is created per application
 * during engine setup, and each surface finds its scope by name through
 * {@link UndoManager.getScope}.
 */
export class UndoManager<S extends Schema> {
  private readonly scopes = new Map<string, UndoScope<S>>();
  /** The options each scope was constructed with, for the mismatch warning below. */
  private readonly creationOptions = new Map<string, UndoScopeOptions | undefined>();

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
      this.creationOptions.set(name, options);
      return scope;
    }
    // A scope keeps the options it was created with; later calls cannot change
    // them. Requesting the shared scope with no options is the normal pattern
    // and stays silent — but passing options that conflict with the creation
    // values means one caller believes it configured a scope that another
    // caller already configured differently, which is how a surface silently
    // ends up with, say, no stream recording. Surface that instead of letting
    // it pass.
    if (options) {
      const created = this.creationOptions.get(name);
      const conflicts: string[] = [];
      if (
        options.recordFromStream !== undefined &&
        options.recordFromStream !== (created?.recordFromStream ?? false)
      ) {
        conflicts.push('recordFromStream');
      }
      if (options.maxHistory !== undefined && options.maxHistory !== (created?.maxHistory ?? 100)) {
        conflicts.push('maxHistory');
      }
      if (
        options.conflictPolicy !== undefined &&
        options.conflictPolicy !== (created?.conflictPolicy ?? DEFAULT_UNDO_CONFLICT_POLICY)
      ) {
        conflicts.push('conflictPolicy');
      }
      if (conflicts.length > 0) {
        getContext().logger.warn(
          `The undo scope "${name}" already exists with different options — ` +
            `${conflicts.join(', ')} cannot be changed after creation and the requested ` +
            `values are ignored. Create the scope with its full options before any ` +
            `caller requests it without them, or use a differently named scope.`,
        );
      }
    }
    return scope;
  }

  clearAll(): void {
    for (const scope of this.scopes.values()) scope.clear();
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Bulk history becomes individually confirmed steps so accepted rows never repeat. */
function expandReplayOps(ops: InverseOp[]): ReplayOperation[] {
  return ops.flatMap((op): ReplayOperation[] => {
    switch (op.kind) {
      case 'createMany': return op.data.map((data) => ({ kind: 'create', modelKey: op.modelKey, data }));
      case 'updateMany': return op.patches.map((patch) => ({ kind: 'update', modelKey: op.modelKey, patch }));
      case 'deleteMany': return op.ids.map((id) => ({ kind: 'delete', modelKey: op.modelKey, id }));
      default: return [op];
    }
  });
}

/** Retain expected values, then advance them only by this replay's accepted changes. */
function captureReplayBaseline(ops: ReplayOperation[], store: SyncStoreContract): ReplayProgress['baseline'] {
  const rows = new Map<string, Extract<InverseOp, { kind: 'update' }>>();
  for (const op of ops) {
    if (op.kind !== 'update' && op.kind !== 'reverse-operation') continue;
    const id = op.kind === 'update' ? op.patch.id : op.id;
    const key = JSON.stringify([op.modelKey, id]);
    const row = rows.get(key) ?? { kind: 'update', modelKey: op.modelKey, patch: { id } };
    const current = store.pool.get(id)?.toJSON() ?? {};
    for (const field of Object.keys(op.patch)) {
      if (field !== 'id') row.patch[field] = structuredClone(current[field]);
    }
    rows.set(key, row);
  }
  return rows;
}

async function applyOps<S extends Schema>(tx: Transaction<S>, progress: ReplayProgress, store: SyncStoreContract, policy: UndoConflictPolicy, origin: MutationOrigin): Promise<void> {
  while (progress.remaining.length) {
    const pending = progress.remaining[0];
    if (!pending) break;
    const baseline = pending.kind === 'update' || pending.kind === 'reverse-operation'
      ? progress.baseline.get(JSON.stringify([pending.modelKey, pending.kind === 'update' ? pending.patch.id : pending.id])) : undefined;
    const op = expandReplayOps(resolveOps([pending], baseline ? [baseline] : [], store, policy))[0];
    if (!op) { progress.remaining.shift(); continue; }
    const mutations: object = tx.mutations;
    const modelMutations = Reflect.get(mutations, op.modelKey);
    if (!modelMutations || typeof modelMutations !== 'object') {
      // A persisted inverse op references a model the schema no longer has;
      // fail with a clear message rather than an opaque TypeError.
      throw new Error(
        `Cannot undo: model "${op.modelKey}" is not part of the current schema.`,
      );
    }

    const invoke = async (method: 'create' | 'update' | 'delete', argument: unknown) => {
      const mutation = Reflect.get(modelMutations, method);
      if (typeof mutation !== 'function') {
        throw new Error(
          `Cannot undo: model "${op.modelKey}" has no "${method}" mutation.`,
        );
      }
      await Reflect.apply(mutation, modelMutations, [argument]);
    };

    switch (op.kind) {
        case 'reverse-operation':
          progress.reversed.push(await reverseFieldOperation(store, op, origin));
          break;
        case 'create':
          await invoke('create', op.data);
          break;
        case 'update':
          await invoke('update', op.patch);
          break;
        case 'delete':
          await invoke('delete', op.id);
          break;
    }
    if (baseline && (op.kind === 'update' || op.kind === 'reverse-operation')) baseline.patch = { ...baseline.patch, ...structuredClone(op.patch) };
    progress.remaining.shift();
    progress.completed++;
  }
}
