/** Application type registry. Ablo's public entry point connects its Register here. */
import type { SchemaRecord } from '../schema/schema.js';

export interface DefaultSyncShape {
  readonly Schema: { readonly models: SchemaRecord };
  readonly UserMeta: { readonly id: string };
  readonly ClaimMeta: Record<string, unknown>;
}
/** Direct Transaction consumers augment this interface. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

export type ResolveSchema = Register extends { Schema: infer S }
  ? S extends { models: Record<string, unknown> }
    ? S
    : DefaultSyncShape['Schema']
  : DefaultSyncShape['Schema'];

export type ResolveUserMeta = Register extends { UserMeta: infer U }
  ? U
  : DefaultSyncShape['UserMeta'];

export type ResolveClaimMeta = Register extends { ClaimMeta: infer M }
  ? M
  : DefaultSyncShape['ClaimMeta'];

/** Require schema inference at the API boundary instead of loose mutator types. */
export type RequireRegisteredSchema<T> = ResolveSchema extends import('../schema/schema.js').Schema
  ? T
  : T & { readonly 'Ablo schema missing: pass schema explicitly or include ablo/register.ts in tsconfig': never };

export type ResolveModelKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;

export type ResolveModels = ResolveSchema extends { models: infer M extends SchemaRecord }
  ? M : SchemaRecord;
