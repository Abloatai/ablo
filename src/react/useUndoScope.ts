'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Schema } from '../schema/schema';
import type { UndoScope, UndoScopeOptions } from '../mutators/UndoManager';
import { UndoManager } from '../mutators/UndoManager';
import type { ResolveSchema } from '../types/global';
import { useSyncContext } from './context';
import { AbloValidationError } from '../errors';

/**
 * useUndoScope — per-surface undo/redo for mutator invocations.
 *
 * Zero deliberately does NOT ship a built-in undo API; consumers build one
 * on top of mutation tracking. This is ours.
 *
 * Each named scope owns an independent undo/redo stack. Wire the returned
 * `scope` into `useMutators(schema, mutators, { undoScope: scope })` and the
 * invocations become recorded. `undo()` / `redo()` replay the inverses /
 * forwards as new transactions that do NOT re-record (the manager pushes
 * them between the two stacks explicitly).
 *
 * @example
 * const { undo, redo, canUndo, canRedo, scope } = useUndoScope('deck-editor');
 * const mutate = useMutators(schema, deckMutators, { undoScope: scope });
 *
 * // Cmd+Z handler
 * useHotkey('mod+z', () => { if (canUndo) void undo(); });
 */

export interface UseUndoScopeResult<S extends Schema> {
  /** Pass to `useMutators(..., { undoScope })` to enable recording. */
  scope: UndoScope<S>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  /** Drop history. Use after sync errors / auth context changes. */
  clear: () => void;
}

// Module-level weak registry: `SyncStoreContract` → `UndoManager`.
// A single app wiring through one SyncProvider shares one manager across
// every useUndoScope call, so scopes with the same name are identity-equal.
const managers = new WeakMap<object, UndoManager<Schema>>();

/**
 * Cast helper: the WeakMap stores the generic erased; we reassert the schema
 * type at retrieval time because scope names are unique per-app and the
 * schema is the same across every hook call in that app.
 */
function getManager<S extends Schema>(
  key: object,
  factory: () => UndoManager<S>,
): UndoManager<S> {
  let m = managers.get(key);
  if (!m) {
    m = factory() as unknown as UndoManager<Schema>;
    managers.set(key, m);
  }
  return m as unknown as UndoManager<S>;
}

/** Per-surface undo/redo (explicit schema arg). */
export function useUndoScope<S extends Schema>(
  schema: S,
  name: string,
  options?: UndoScopeOptions,
): UseUndoScopeResult<S>;

/** Per-surface undo/redo via the `AbloSync` global augmentation. */
export function useUndoScope(
  name: string,
  options?: UndoScopeOptions,
): UseUndoScopeResult<ResolveSchema extends Schema ? ResolveSchema : Schema>;

export function useUndoScope(
  schemaOrName: Schema | string,
  nameOrOptions?: string | UndoScopeOptions,
  maybeOptions?: UndoScopeOptions,
): UseUndoScopeResult<Schema> {
  const { store, organizationId, schema: ctxSchema } = useSyncContext();

  const isExplicit = typeof schemaOrName !== 'string';
  const schema = isExplicit ? (schemaOrName as Schema) : ctxSchema;
  const name = isExplicit ? (nameOrOptions as string) : schemaOrName;
  const options = (isExplicit ? maybeOptions : nameOrOptions) as UndoScopeOptions | undefined;

  if (!schema) {
    throw new AbloValidationError(
      'useUndoScope: no schema available. Pass the schema as the first arg ' +
        'or wire SyncProvider with a `schema` prop when using the zero-arg overload.',
      { code: 'undo_scope_schema_missing' },
    );
  }

  const scope = useMemo(() => {
    // Store is the identity for the manager — one per SyncProvider.
    const manager = getManager<Schema>(store, () => new UndoManager(schema, store, organizationId));
    return manager.getScope(name, options);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, organizationId, name]);

  // Local tick forces re-render after undo/redo/clear so canUndo/canRedo
  // reflect the new stack sizes. The scope itself doesn't emit React-
  // friendly notifications; callers that want cross-component reactivity
  // can wire a mobx observable or custom event bus on top.
  const [, setTick] = useState(0);

  // Reset tick when scope identity changes (new store / new orgId).
  useEffect(() => {
    setTick(0);
  }, [scope]);

  const size = scope.size();

  return {
    scope,
    undo: async () => {
      await scope.undo();
      setTick((t: number) => t + 1);
    },
    redo: async () => {
      await scope.redo();
      setTick((t: number) => t + 1);
    },
    canUndo: size.undo > 0,
    canRedo: size.redo > 0,
    clear: () => {
      scope.clear();
      setTick((t: number) => t + 1);
    },
  };
}
