'use client';

import { useMemo } from 'react';
import type { Schema } from '@abloatai/transaction/schema/schema';
import type {
  MutatorDefs,
  MutatorFn,
} from '../local/mutators/defineMutators.js';
import { createTransaction } from '../local/mutators/Transaction.js';
import { createRecordingMutation } from '../local/mutators/RecordingMutation.js';
import type { UndoScope } from '../local/mutators/UndoManager.js';
import type { ResolveSchema, RequireRegisteredSchema } from '@abloatai/transaction/types/global';
import { useAbloStoreContext } from './context.js';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { getContext } from '../local/context.js';

/**
 * Turns a mutator tree built with `defineMutators` into callable invokers. The
 * returned object mirrors that tree one-to-one, but each leaf becomes an
 * `(args) => Promise<TResult>` function.
 *
 * Each invocation builds a fresh `Transaction` bound to the current store and
 * organization, calls your mutator with `{ tx, args }`, and returns whatever
 * the mutator resolves to.
 *
 * If a mutator throws, the error propagates to the caller and any writes it
 * already dispatched stay in place — there is no automatic rollback. Wrap the
 * call in your own try/catch and issue compensating writes when you need to
 * undo a partial change, or pass an `undoScope` (see {@link useMutators.Options})
 * to record inverses for undo and redo.
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
/** Mutator invokers (explicit schema arg). */
export function useMutators<S extends Schema, M extends MutatorDefs<S>>(
  schema: S,
  mutators: M,
  options?: useMutators.Options<S>,
): useMutators.Result<M>;

/** Mutator invokers via the `Register` module augmentation. Schema comes
 * from the `AbloProvider` store context; the mutator tree is typed against
 * `ResolveSchema` at the call site. */
export function useMutators<
  M extends ResolveSchema extends Schema ? MutatorDefs<ResolveSchema> : MutatorDefs<Schema>,
>(
  mutators: RequireRegisteredSchema<M>,
  options?: useMutators.Options<ResolveSchema extends Schema ? ResolveSchema : Schema>,
): useMutators.Result<M>;

export function useMutators(
  schemaOrMutators: Schema | MutatorDefs<Schema>,
  mutatorsOrOptions?: MutatorDefs<Schema> | useMutators.Options<Schema>,
  maybeOptions?: useMutators.Options<Schema>,
): useMutators.Result<MutatorDefs<Schema>> {
  const { store, organizationId, schema: ctxSchema } = useAbloStoreContext();

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
    | useMutators.Options<Schema>
    | undefined;

  if (!schema) {
    throw new AbloValidationError(
      'useMutators: no schema available. Pass the schema as the first arg, ' +
        'or build the <AbloProvider> above with `Ablo({ schema })` so the ' +
        'schema-free overload can read it from context.',
      { code: 'mutators_schema_missing' },
    );
  }

  const { undoScope } = options ?? {};

  return useMemo<useMutators.Result<MutatorDefs<Schema>>>(() => {
    const out: Record<string, Record<string, (args: unknown) => Promise<unknown>>> = {};

    for (const modelKey of Object.keys(mutators)) {
      const group = (mutators as Record<string, Record<string, MutatorFn<Schema, unknown, unknown>>>)[modelKey];
      if (!group) continue;

      const invokers: Record<string, (args: unknown) => Promise<unknown>> = {};
      for (const mutatorName of Object.keys(group)) {
        const maybeFn = group[mutatorName];
        if (!maybeFn) continue;
        // Bind the narrowed value: `noUncheckedIndexedAccess` types the indexed
        // read as `Fn | undefined`, and that narrowing doesn't survive into the
        // deferred invoker closures below — a non-optional local does.
        const fn = maybeFn;
        const label = `${String(modelKey)}.${mutatorName}`;

        invokers[mutatorName] = async (args: unknown) => {
          // Recording path: wrap the transaction so each write snapshots its
          // inverse. On success, push the captured entry to the scope.
          //
          // The whole snapshot → write → record sequence runs on the scope's
          // serialization chain so concurrent invocations (a caller may fire
          // writes without awaiting them) record in invocation order and never
          // interleave their shared-model snapshots. See UndoScope.runRecorded.
          if (undoScope) {
            return undoScope.runRecorded(async () => {
              const recording = createRecordingMutation(schema, store, organizationId);
              try {
                const result = await fn({ tx: recording.tx, args });
                const entry = recording.getEntry(label);
                if (entry) undoScope.record(entry);
                return result;
              } catch (err) {
                // The error is re-thrown to the caller's await (the real
                // consumer surface), so this is a forensic follow-on → debug.
                getContext().logger.debug(
                  `[useMutators] mutator "${label}" threw`,
                  { error: err },
                );
                throw err;
              }
            });
          }

          // Non-recording path — plain transaction, no inverse capture.
          const tx = createTransaction(schema, store, organizationId);
          try {
            return await fn({ tx, args });
          } catch (err) {
            // Re-thrown to the caller's await (the real consumer surface) →
            // this duplicate is forensic, debug only.
            getContext().logger.debug(
              `[useMutators] mutator "${label}" threw`,
              { error: err },
            );
            throw err;
          }
        };
      }

      out[modelKey] = invokers;
    }

    return out;
  }, [schema, mutators, store, organizationId, undoScope]);
}

/** Optional annotations for custom mutation bindings. */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace useMutators {
  export type Result<M> = {
    [K in keyof M]: {
      [N in keyof M[K]]: InvokerFor<M[K][N]>;
    };
  };

  /**
   * Options passed to `useMutators`. When `undoScope` is set, every mutator
   * invocation is wrapped in a `RecordingMutation` and its inverses are
   * pushed to the scope as one undo entry.
   */
  export interface Options<S extends Schema> {
    /** Target undo scope for recording inverses. Omit to disable recording. */
    undoScope?: UndoScope<S>;
  }
}
