/**
 * defineMutators — Zero-style custom mutator declaration.
 *
 * Consumers declare a tree of named mutators grouped by model key. Each
 * mutator is a plain async function that receives `{ tx, args }`. The body
 * composes any number of `tx.mutate.*` / `tx.read.*` calls to implement a
 * named operation (e.g. `slides.createWithLayers`).
 *
 * This file is pure type scaffolding + a pass-through factory. The runtime
 * dispatcher lives in `./Transaction` (the `tx` object) and
 * `../react/useMutators` (the React-side invoker builder). Keeping those
 * concerns separate makes the types trivially inferable at the call site:
 * `defineMutators(schema, { ... })` returns the literal object the consumer
 * wrote, so `typeof mutators` carries every mutator's exact `args`/result
 * signature into `useMutators`.
 */

import type { Schema } from '../schema/schema';
import type { Transaction } from './Transaction';

/**
 * Signature of a single custom mutator. The host injects `tx`; the consumer
 * controls `args` (whatever shape they want) and the resolved return value.
 *
 * We bound `TArgs`/`TResult` with `unknown` rather than `any` so consumers
 * opt into the inference they need — the `MutatorDefs` record relaxes to
 * `unknown` to let heterogeneous mutator trees unify without `any`.
 */
export type MutatorFn<S extends Schema, TArgs, TResult = void> = (
  options: { tx: Transaction<S>; args: TArgs },
) => Promise<TResult>;

/**
 * The shape `defineMutators` accepts: an optional record per model key whose
 * values are named mutator functions.
 *
 * We intentionally use `unknown` in the bounds rather than `any` to preserve
 * type-safety at the public API boundary. When a consumer writes their
 * mutators inline, TypeScript infers the concrete `TArgs`/`TResult` for each
 * function — the `unknown` here is just a ceiling, not what the consumer
 * ends up seeing.
 */
export type MutatorDefs<S extends Schema> = {
  [K in keyof S['models']]?: {
    [mutatorName: string]: MutatorFn<S, never, unknown>;
  };
};

/**
 * Identity function that forwards the mutators object while constraining its
 * shape against the schema. The `S` generic pins model keys; the `M` generic
 * is `const`-inferred so each mutator's literal signature survives.
 *
 * Pattern mirrors Zero's own `defineMutators` / `createBuilder` — there is
 * no runtime work to do here, it's purely a location for type inference to
 * anchor.
 */
export function defineMutators<
  S extends Schema,
  const M extends MutatorDefs<S>,
>(_schema: S, mutators: M): M {
  return mutators;
}
