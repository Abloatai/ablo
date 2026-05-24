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

// ── Inverse op model ──────────────────────────────────────────────────────

/**
 * A single reversible operation. The runtime captures these during a
 * recorded transaction and replays them (in reverse order) on undo.
 * Model keys and data shapes are stored as strings/records so the manager
 * is schema-agnostic — the transaction it replays through is schema-typed.
 */
export type InverseOp =
  | { kind: 'create'; modelKey: string; data: Record<string, unknown> }
  | { kind: 'update'; modelKey: string; patch: { id: string } & Record<string, unknown> }
  | { kind: 'delete'; modelKey: string; id: string }
  | { kind: 'createMany'; modelKey: string; data: Record<string, unknown>[] }
  | { kind: 'updateMany'; modelKey: string; patches: Array<{ id: string } & Record<string, unknown>> }
  | { kind: 'deleteMany'; modelKey: string; ids: string[] };

/** One undo entry = one mutator invocation's set of inverses, in reverse order. */
export interface UndoEntry {
  /** Optional label for diagnostics / UI ("Move layer", "Delete slide", etc). */
  label?: string;
  inverses: InverseOp[];
  /**
   * Paired forward ops, captured at record time so redo can replay them
   * without re-running the user's mutator (which may have non-idempotent
   * side effects like generating new IDs).
   */
  forwards: InverseOp[];
}

// ── Scope ──────────────────────────────────────────────────────────────────

export interface UndoScopeOptions {
  /** Max number of undo entries. Older entries drop off the bottom. Default: 100. */
  maxHistory?: number;
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

  constructor(
    private readonly schema: S,
    private readonly store: SyncStoreContract,
    private readonly organizationId: string,
    options: UndoScopeOptions = {},
  ) {
    this.maxHistory = options.maxHistory ?? 100;
  }

  /** Internal: record a mutator's inverses. Clears the redo stack. */
  record(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Pop the last mutator and apply its inverses. Pushes to redo. */
  async undo(): Promise<void> {
    const entry = this.undoStack.pop();
    if (!entry) return;
    const tx = createTransaction(this.schema, this.store, this.organizationId);
    await applyOps(tx, entry.inverses);
    this.redoStack.push(entry);
    if (this.redoStack.length > this.maxHistory) this.redoStack.shift();
  }

  /** Pop the last undone entry and re-apply the forward ops. Pushes to undo. */
  async redo(): Promise<void> {
    const entry = this.redoStack.pop();
    if (!entry) return;
    const tx = createTransaction(this.schema, this.store, this.organizationId);
    await applyOps(tx, entry.forwards);
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
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
