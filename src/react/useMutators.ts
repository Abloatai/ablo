'use client';

import { useMemo } from 'react';
import type { Schema } from '../schema/schema.js';
import type { MutatorDefs, MutatorFn } from '../mutators/defineMutators.js';
import { createTransaction } from '../mutators/Transaction.js';
import { createRecordingTransaction } from '../mutators/RecordingTransaction.js';
import type { UndoScope } from '../mutators/UndoManager.js';
import type { ResolveSchema } from '../types/global.js';
import { useSyncContext } from './context.js';
import { AbloValidationError } from '../errors.js';
import { getContext } from '../context.js';

/**
 * useMutators — turn a `defineMutators` tree into callable invokers.
 *
 * The returned object mirrors the mutator tree one-to-one, but each leaf is
 * now a `(args) => Promise<TResult>` function. Internally each invocation:
 *   1. Builds a fresh `Transaction` bound to the current store/org context.
 *   2. Calls the user's mutator with `{ tx, args }`.
 *   3. Returns the mutator's resolved value.
 *
 * V1 error handling: if the mutator throws, we `console.error` + rethrow.
 * Any writes that already dispatched stay in place (no rollback). That
 * matches the existing behaviour of batch helpers like `saveManyOptimized`
 * and keeps the contract honest — consumers can layer their own try/catch
 * + compensating writes until V2 adds atomicity.
 */

/**
 * Map a `MutatorFn` onto its invoker form — strip `tx`, keep `args`/return.
 *
 * Uses nested `infer O` so the `args`/`result` types are extracted from the
 * function signature without binding the `tx` parameter to a specific
 * `Transaction<S>` variance. Function parameters are contravariant, so a
 * match against `MutatorFn<Schema>` would reject mutators declared against
 * a narrower schema (e.g. `Transaction<typeof appSchema>`). The two-step
 * inference sidesteps that without resorting to `any`/`unknown` placeholders.
 */
export type InvokerFor<F> = F extends (options: infer O) => Promise<infer R>
  ? O extends { args: infer A }
    ? (args: A) => Promise<R>
    : never
  : never;

/**
 * The hook's return shape: same tree as the input `MutatorDefs`, every leaf
 * rewritten to its invoker form.
 */
export type MutatorInvokers<M> = {
  [K in keyof M]: {
    [N in keyof M[K]]: InvokerFor<M[K][N]>;
  };
};

/**
 * Options passed to `useMutators`. When `undoScope` is set, every mutator
 * invocation is wrapped in a `RecordingTransaction` and its inverses are
 * pushed to the scope as one undo entry.
 */
export interface UseMutatorsOptions<S extends Schema> {
  /** Target undo scope for recording inverses. Omit to disable recording. */
  undoScope?: UndoScope<S>;
}

/** Mutator invokers (explicit schema arg). */
export function useMutators<S extends Schema, M extends MutatorDefs<S>>(
  schema: S,
  mutators: M,
  options?: UseMutatorsOptions<S>,
): MutatorInvokers<M>;

/** Mutator invokers via the `Register` module augmentation. Schema comes
 * from the `SyncProvider`'s context; the mutator tree is typed against
 * `ResolveSchema` at the call site. */
export function useMutators<
  M extends ResolveSchema extends Schema ? MutatorDefs<ResolveSchema> : MutatorDefs<Schema>,
>(
  mutators: M,
  options?: UseMutatorsOptions<ResolveSchema extends Schema ? ResolveSchema : Schema>,
): MutatorInvokers<M>;

export function useMutators(
  schemaOrMutators: Schema | MutatorDefs<Schema>,
  mutatorsOrOptions?: MutatorDefs<Schema> | UseMutatorsOptions<Schema>,
  maybeOptions?: UseMutatorsOptions<Schema>,
): MutatorInvokers<MutatorDefs<Schema>> {
  const { store, organizationId, schema: ctxSchema } = useSyncContext();

  // Disambiguate: explicit-schema path has the schema object in first slot;
  // the global-resolved path has the mutator tree there. A schema object
  // has a `.models` property; a mutator tree doesn't.
  const isExplicit =
    typeof schemaOrMutators === 'object' &&
    schemaOrMutators !== null &&
    'models' in schemaOrMutators;

  const schema = isExplicit ? (schemaOrMutators as Schema) : ctxSchema;
  const mutators = (isExplicit ? mutatorsOrOptions : schemaOrMutators) as MutatorDefs<Schema>;
  const options = (isExplicit ? maybeOptions : mutatorsOrOptions) as
    | UseMutatorsOptions<Schema>
    | undefined;

  if (!schema) {
    throw new AbloValidationError(
      'useMutators: no schema available. Pass the schema as the first arg ' +
        'or wire SyncProvider with a `schema` prop when using the zero-arg overload.',
      { code: 'mutators_schema_missing' },
    );
  }

  const { undoScope } = options ?? {};

  return useMemo<MutatorInvokers<MutatorDefs<Schema>>>(() => {
    const out: Record<string, Record<string, (args: unknown) => Promise<unknown>>> = {};

    for (const modelKey of Object.keys(mutators)) {
      const group = (mutators as Record<string, Record<string, MutatorFn<Schema, unknown, unknown>>>)[modelKey];
      if (!group) continue;

      const invokers: Record<string, (args: unknown) => Promise<unknown>> = {};
      for (const mutatorName of Object.keys(group)) {
        const fn = group[mutatorName];
        const label = `${String(modelKey)}.${mutatorName}`;

        invokers[mutatorName] = async (args: unknown) => {
          // Recording path: wrap the transaction so each write snapshots its
          // inverse. On success, push the captured entry to the scope.
          //
          // The whole snapshot → write → record sequence runs on the scope's
          // serialization chain so concurrent invocations (the slides UI fires
          // writes un-awaited) record in *invocation* order and never
          // interleave their shared-model snapshots. See UndoScope.runRecorded.
          if (undoScope) {
            return undoScope.runRecorded(async () => {
              const recording = createRecordingTransaction(schema, store, organizationId);
              try {
                const result = await fn({ tx: recording.tx, args });
                const entry = recording.getEntry(label);
                if (entry) undoScope.record(entry);
                return result;
              } catch (err) {
                getContext().logger.error(
                  `[useMutators] mutator "${label}" threw`,
                  { error: err },
                );
                throw err;
              }
            });
          }

          // Non-recording path — plain transaction, identical to pre-undo V1.
          const tx = createTransaction(schema, store, organizationId);
          try {
            return await fn({ tx, args });
          } catch (err) {
            getContext().logger.error(
              `[useMutators] mutator "${label}" threw`,
              { error: err },
            );
            throw err;
          }
        };
      }

      out[modelKey] = invokers;
    }

    return out as MutatorInvokers<MutatorDefs<Schema>>;
  }, [schema, mutators, store, organizationId, undoScope]);
}
