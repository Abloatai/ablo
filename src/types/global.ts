/**
 * The single place where you tell the SDK about your application's types.
 *
 * You register your Schema, Presence, Claims, and UserMeta once by augmenting
 * the {@link Register} interface. From then on every SDK hook — `useAblo`,
 * `useQuery`, `useOne`, `usePresence`, `useClaim` — reads its types from that
 * registration, so you never pass a generic or a `schema` argument at a call
 * site.
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
 *     Presence: { cursor: { x: number; y: number } | null };
 *     Claims: { editLayer: { layerId: string } };
 *     UserMeta: { id: string; email: string };
 *   }
 * }
 * export {};
 * ```
 *
 * When `Register` is never augmented, every resolver falls back to
 * {@link DefaultSyncShape} — a loose shape that keeps your code compiling
 * without typed results until you opt in.
 */

/**
 * The fallback shapes the resolvers use when {@link Register} has not been
 * augmented. `DefaultSyncShape.Schema` is deliberately structural — it carries
 * `{ models: Record<string, unknown> }` so hooks can still check a model-key
 * argument against something, just without a typed entity shape behind it.
 */
export interface DefaultSyncShape {
  readonly Schema: { readonly models: Record<string, unknown> };
  readonly Presence: Record<string, unknown>;
  readonly Claims: Record<string, unknown>;
  readonly UserMeta: { readonly id: string };
}

/**
 * The registration interface you augment to declare your application's types.
 * Add keys inside a `declare module '@abloatai/ablo'` block — for example
 * `interface Register { Schema: ...; Presence: ...; }`. It is empty by default,
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
 * Your registered presence shape, or the default when none is registered.
 * `usePresence` reads it. The shape is free-form — any JSON-serializable value
 * you broadcast per session.
 */
export type ResolvePresence = Register extends { Presence: infer P }
  ? P
  : DefaultSyncShape['Presence'];

/**
 * Your registered claim vocabulary, or the default when none is registered.
 * Each key is a claim name and its value is that claim's payload.
 * `useClaim(claimName)` reads it.
 */
export type ResolveClaims = Register extends { Claims: infer I }
  ? I
  : DefaultSyncShape['Claims'];

/**
 * Your registered user-metadata shape, or the default when none is registered.
 * It carries identity information you trust from your own auth layer; the SDK
 * does not validate it.
 */
export type ResolveUserMeta = Register extends { UserMeta: infer U }
  ? U
  : DefaultSyncShape['UserMeta'];

/**
 * The union of your schema's model names. `useQuery(modelKey)` narrows its
 * first argument to this union, so a misspelled or unknown model name fails at
 * compile time.
 */
export type ResolveModelKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;
