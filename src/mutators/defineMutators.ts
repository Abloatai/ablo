/**
 * Declares a tree of named custom mutators grouped by model key. Each mutator is
 * a plain async function that receives `{ tx, args }` and composes any number of
 * `tx.mutations.*` and `tx.read.*` calls to carry out a named operation, such as
 * `slides.createWithLayers`.
 *
 * The function is purely a place for types to anchor and returns its input
 * unchanged; the runtime that dispatches a mutator lives elsewhere — the
 * transaction object it receives and the React hook that invokes it. Because
 * `defineMutators(schema, { ... })` returns the exact object you wrote,
 * `typeof mutators` carries every mutator's precise `args` and result types
 * through to wherever they are invoked.
 */

import type { Schema } from '../schema/schema.js';
import type { Transaction } from './Transaction.js';

/**
 * The signature of a single custom mutator. The engine supplies `tx`; you control
 * `args`, in whatever shape you like, and the resolved return value. `TArgs` and
 * `TResult` are bounded by `unknown` rather than `any`, so a mixed tree of
 * mutators can be typed together without falling back to `any`.
 */
export type MutatorFn<S extends Schema, TArgs, TResult = void> = (
  options: { tx: Transaction<S>; args: TArgs },
) => Promise<TResult>;

/**
 * The shape {@link defineMutators} accepts: an optional record per model key
 * whose values are named mutator functions. The `unknown` bounds keep the public
 * boundary type-safe without `any`; when you write your mutators inline,
 * TypeScript still infers the concrete `args` and result of each function, so the
 * `unknown` here is only a ceiling, not what you end up working with.
 */
export type MutatorDefs<S extends Schema> = {
  [K in keyof S['models']]?: Record<string, MutatorFn<S, never, unknown>>;
};

/**
 * Returns the mutators object unchanged while constraining its shape against the
 * schema. The `S` generic pins the model keys, and the `M` generic is inferred as
 * a `const`, so each mutator's literal signature survives. There is no runtime
 * work here; the function exists purely as a place for type inference to anchor.
 */
export function defineMutators<
  S extends Schema,
  const M extends MutatorDefs<S>,
>(_schema: S, mutators: M): M {
  return mutators;
}
