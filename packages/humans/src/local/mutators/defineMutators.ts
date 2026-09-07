/** Define typed named operations. Pass the schema explicitly across package boundaries. */
import type { Schema } from '@abloatai/transaction/schema/schema';
import type { Transaction } from './Transaction.js';
import type { ResolveSchema, RequireRegisteredSchema } from '@abloatai/transaction/types/global';

type RegisteredSchema = ResolveSchema extends Schema ? ResolveSchema : Schema;

export type MutatorFn<S extends Schema, TArgs, TResult = void> = (
  options: { tx: Transaction<S>; args: TArgs },
) => Promise<TResult>;

export type MutatorDefs<S extends Schema> = {
  [K in keyof S['models']]?: Record<string, MutatorFn<S, never, unknown>>;
};

export function defineMutators<
  S extends Schema,
  const M extends MutatorDefs<S>,
>(_schema: S, mutators: M): M;
export function defineMutators<const M extends MutatorDefs<RegisteredSchema>>(
  mutators: RequireRegisteredSchema<M>,
): M;
export function defineMutators(
  schemaOrMutators: Schema | MutatorDefs<Schema>,
  maybeMutators?: MutatorDefs<Schema>,
): MutatorDefs<Schema> {
  return (maybeMutators ?? schemaOrMutators) as MutatorDefs<Schema>;
}
