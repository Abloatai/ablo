/**
 * Type registration point for SDK consumers.
 *
 * A consumer registers their Schema, Presence, Claims, and UserMeta ONCE by
 * augmenting the {@link Register} interface, and every SDK hook — `useAblo`,
 * `useQuery`, `useOne`, `usePresence`, `useClaim` — reads its types from the
 * resolved registration. No generics at call sites, no `schema` arg per call.
 *
 * Registration is done via **module augmentation** of `@abloatai/ablo` —
 * the same pattern TanStack Router uses for its `Register` interface. The brand
 * lives in the module specifier, so the interface is just `Register` (not a
 * global, not prefixed). It's a language feature, not a library trick: any file
 * in the compilation can augment it and every resolver below picks it up.
 *
 * Consumer example (`npx ablo init` scaffolds this as `ablo/register.ts`, a
 * sibling of `ablo/schema.ts`). It's a regular `.ts` module, NOT a hand-authored
 * `.d.ts`: the top-level `import type { schema }` makes the `declare module`
 * block MERGE (augment) this interface rather than collide with it — the same
 * shape TanStack Router uses in `src/router.tsx`. Any `.ts` file in the
 * `tsconfig` `include` works; it never needs to be imported.
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
 * If `Register` is never augmented, every resolver falls back to
 * {@link DefaultSyncShape} — a loose shape that keeps consumers compiling
 * without typed benefits until they opt in.
 */

/**
 * Default fallback shapes used when the consumer hasn't augmented
 * {@link Register}. `DefaultSyncShape.Schema` is intentionally structural — it
 * carries `{ models: Record<string, unknown> }` so hooks can still validate the
 * model key argument against *something*, just without a typed entity shape.
 */
export interface DefaultSyncShape {
  readonly Schema: { readonly models: Record<string, unknown> };
  readonly Presence: Record<string, unknown>;
  readonly Claims: Record<string, unknown>;
  readonly UserMeta: { readonly id: string };
}

/**
 * The registration interface. Consumers augment it via
 * `declare module '@abloatai/ablo' { interface Register { Schema: ...; … } }`.
 * Empty by default — every SDK resolver falls back to {@link DefaultSyncShape}
 * when an expected key is absent. Exported from the package root so the module
 * augmentation merges into this declaration.
 *
 * The `Schema` augmentation key holds the type produced by `defineSchema`, so
 * the same noun reads consistently here and in {@link ResolveSchema}.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

/**
 * The consumer's schema, or the default shape if unregistered. Hooks use this
 * to type their model-key argument and infer the entity type returned.
 */
export type ResolveSchema = Register extends { Schema: infer S }
  ? S extends { models: Record<string, unknown> }
    ? S
    : DefaultSyncShape['Schema']
  : DefaultSyncShape['Schema'];

/**
 * The consumer's presence shape, or the default if unregistered. Used by
 * `usePresence`. Free-form — any serializable JSON broadcast per session.
 */
export type ResolvePresence = Register extends { Presence: infer P }
  ? P
  : DefaultSyncShape['Presence'];

/**
 * The consumer's claim vocabulary, or the default if unregistered. Keys are
 * claim names; values are the claim payload for each claim. Used by
 * `useClaim(claimName)`.
 */
export type ResolveClaims = Register extends { Claims: infer I }
  ? I
  : DefaultSyncShape['Claims'];

/**
 * The consumer's user-metadata shape, or the default if unregistered. Carries
 * identity info the consumer trusts from their auth layer — not SDK-validated.
 */
export type ResolveUserMeta = Register extends { UserMeta: infer U }
  ? U
  : DefaultSyncShape['UserMeta'];

/**
 * The keys of the consumer's schema models. `useQuery(modelKey)` narrows its
 * first argument to this union, so unknown key literals fail at compile time.
 */
export type ResolveModelKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;
