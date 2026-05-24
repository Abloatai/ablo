/**
 * Typed-global augmentation point for SDK consumers.
 *
 * Consumers declare their Schema, Presence, Intents, and UserMeta ONCE in a
 * `.d.ts` file and every SDK hook — `useQuery`, `useOne`, `useMutate`,
 * `usePresence`, `useIntent` — reads its types from the resolved global.
 * No generics at call sites. No `schema` runtime arg passed per hook call.
 *
 * This is the same canonical TypeScript declaration-merging pattern that
 * Next.js uses for `process.env` / `NodeJS.ProcessEnv`, that CSS Modules
 * use for `declare module '*.module.css'`, and that Liveblocks uses for
 * `interface Liveblocks`. It's a language feature, not a library trick —
 * any file in the compilation can augment the global `AbloSync` interface
 * and every consumer of the resolved types below picks up the augmentation
 * automatically.
 *
 * Consumer example:
 *
 * ```ts
 * // apps/your-app/src/ablo-sync.d.ts
 * import type { schema } from './your-schema';
 *
 * declare global {
 *   interface AbloSync {
 *     Schema: typeof schema;
 *     Presence: { cursor: { x: number; y: number } | null };
 *     Intents: { editLayer: { layerId: string } };
 *     UserMeta: { id: string; email: string };
 *   }
 * }
 * export {};
 * ```
 *
 * If `AbloSync` is never declared, every resolver falls back to the
 * `DefaultSyncShape` — a loose `Record<string, unknown>` shape that keeps
 * SDK consumers compiling without typed benefits until they opt in.
 */

// eslint-disable-next-line @typescript-eslint/no-empty-object-type

/**
 * Default fallback shapes used when the consumer hasn't declared
 * `interface AbloSync`. `DefaultSyncShape.Schema` is intentionally
 * structural — it carries `{ models: Record<string, unknown> }` so hooks
 * can still validate the model key argument against *something*, just
 * without producing a typed entity shape. Once the consumer augments the
 * global, every resolver below picks up the augmented types automatically.
 */
export interface DefaultSyncShape {
  readonly Schema: { readonly models: Record<string, unknown> };
  readonly Presence: Record<string, unknown>;
  readonly Intents: Record<string, unknown>;
  readonly UserMeta: { readonly id: string };
}

declare global {
  /**
   * Global augmentation target. Consumers augment this via
   * `declare global { interface AbloSync { Schema: ...; Presence: ...; ... } }`.
   * Empty by default — every SDK resolver falls back to {@link DefaultSyncShape}
   * when an expected key is absent.
   */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface AbloSync {}
}

/**
 * The consumer's schema, or the default shape if undeclared. Hooks use
 * this to type their model-key argument and to infer the entity type
 * returned from queries/mutations.
 */
export type ResolveSchema = AbloSync extends { Schema: infer S }
  ? S extends { models: Record<string, unknown> }
    ? S
    : DefaultSyncShape['Schema']
  : DefaultSyncShape['Schema'];

/**
 * The consumer's presence shape, or the default shape if undeclared.
 * Used by `usePresence`. The shape is free-form — any serializable JSON
 * the consumer wants to broadcast per session.
 */
export type ResolvePresence = AbloSync extends { Presence: infer P }
  ? P
  : DefaultSyncShape['Presence'];

/**
 * The consumer's intent vocabulary, or the default if undeclared. Keys
 * are intent names; values are the claim payload for each intent. Used
 * by `useIntent(intentName)`.
 */
export type ResolveIntents = AbloSync extends { Intents: infer I }
  ? I
  : DefaultSyncShape['Intents'];

/**
 * The consumer's user-metadata shape, or the default if undeclared.
 * Carries identity info the consumer trusts from their auth layer —
 * the SDK doesn't validate this.
 */
export type ResolveUserMeta = AbloSync extends { UserMeta: infer U }
  ? U
  : DefaultSyncShape['UserMeta'];

/**
 * The keys of the consumer's schema models. `useQuery(modelKey)` narrows
 * its first argument to this union, so unknown key literals fail at
 * compile time.
 */
export type ResolveModelKey = ResolveSchema extends { models: infer M }
  ? keyof M & string
  : string;
