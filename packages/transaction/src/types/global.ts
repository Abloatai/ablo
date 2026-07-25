/**
 * The single place where you tell the SDK about your application's types.
 *
 * You register your Schema, UserMeta and ClaimMeta once by augmenting the
 * {@link Register} interface. From then on the typed SDK surface reads its
 * types from that registration, so you never pass a generic or a `schema`
 * argument at a call site.
 *
 * Registration uses TypeScript module augmentation: any file in your project
 * can add an `interface Register` to a `declare module '@abloatai/ablo'`
 * block, and every resolver below picks it up. Because the name is scoped to
 * this module, the interface is simply `Register` — not a global and not
 * prefixed.
 *
 * The `npx ablo init` command scaffolds this file as `ablo/register.ts`, next
 * to `ablo/schema.ts`. Write it as a normal `.ts` module, not a hand-authored
 * `.d.ts`: the top-level `import type { schema }` is what makes the
 * `declare module` block merge into this interface rather than collide with it.
 * Any `.ts` file covered by your `tsconfig` works, and it never needs to be
 * imported anywhere.
 *
 * ```ts
 * // ablo/register.ts
 * import type { schema } from './schema';
 *
 * declare module '@abloatai/ablo' {
 *   interface Register {
 *     Schema: typeof schema;
 *     UserMeta: { id: string; email: string };
 *     ClaimMeta: { blocks: string[] };
 *   }
 * }
 * export {};
 * ```
 *
 * When `Register` is never augmented, every resolver falls back to
 * {@link DefaultSyncShape} — a loose shape that keeps your code compiling
 * without typed results until you opt in.
 */

import type { SchemaRecord } from '../schema/schema.js';

/**
 * The fallback shapes the resolvers use when {@link Register} has not been
 * augmented. `DefaultSyncShape.Schema` is deliberately structural — it carries
 * `{ models: SchemaRecord }` so hooks can still check a model-key argument
 * against something (and satisfy the `SchemaRecord` bound), just without a
 * typed entity shape behind it.
 */
export interface DefaultSyncShape {
  // `models` is a `SchemaRecord` (not `Record<string, unknown>`) so that
  // `ResolveSchema['models']` still satisfies the `R extends SchemaRecord`
  // bound on the SDK hooks when no `Register` is present — e.g. a shared
  // package (`@ablo/documents`, `@ablo/teams`) typechecked standalone, with no
  // app registration in scope. Without this the fallback wouldn't type-check
  // against `useAblo<R>()`/`AbloProvider<R>` and every such package would need
  // its own ambient registration.
  readonly Schema: { readonly models: SchemaRecord };
  readonly UserMeta: { readonly id: string };
  // The shape a claim's `meta` has when nothing is registered: exactly as loose
  // as it has always been, so an unregistered program reads
  // `claim.state({ id })?.target.meta` the way it does today. The answer to
  // "what if nothing is declared" is the shape callers already have — never
  // `never`, which would make every existing read an error, and never `any`,
  // which would make every existing read a lie.
  readonly ClaimMeta: Record<string, unknown>;
}

/**
 * The registration interface you augment to declare your application's types.
 * Add keys inside a `declare module '@abloatai/ablo'` block — for example
 * `interface Register { Schema: ...; UserMeta: ...; ClaimMeta: ...; }`. It is
 * empty by default,
 * so any key you omit falls back to {@link DefaultSyncShape}. It is exported
 * from the package root so your augmentation merges into this declaration.
 *
 * The `Schema` key holds the type returned by `defineSchema`, and
 * {@link ResolveSchema} reads it back out.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

/**
 * Your registered schema, or the default shape when none is registered. Hooks
 * read this to type their model-key argument and to infer the entity type they
 * return.
 */
export type ResolveSchema = Register extends { Schema: infer S }
  ? S extends { models: Record<string, unknown> }
    ? S
    : DefaultSyncShape['Schema']
  : DefaultSyncShape['Schema'];

/**
 * Your registered user-metadata shape, or the default when none is registered.
 * It carries identity information you trust from your own auth layer; the SDK
 * does not validate it.
 */
export type ResolveUserMeta = Register extends { UserMeta: infer U }
  ? U
  : DefaultSyncShape['UserMeta'];

/**
 * The application metadata your claims carry, or the default when none is
 * registered. It rides along on a claim's target — the SDK transports it
 * verbatim, never interprets it, and never validates it, so the shape is
 * yours to declare and yours alone to keep true.
 *
 * Declaring it here is what makes `claim.state({ id })?.target.meta` readable
 * without a `typeof` guard, on every claim surface at once.
 */
export type ResolveClaimMeta = Register extends { ClaimMeta: infer M }
  ? M
  : DefaultSyncShape['ClaimMeta'];

/**
 * The union of your schema's model names. `useQuery(modelKey)` narrows its
 * first argument to this union, so a misspelled or unknown model name fails at
 * compile time.
 */
export type ResolveModelKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;
