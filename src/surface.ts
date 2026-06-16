/**
 * Machine-checked public API-surface manifest — the SDK owns the description of
 * its OWN surface, bound to the real exported types at COMPILE TIME so the MCP
 * `get_api_surface` / docs can never drift from reality.
 *
 * This exists because the hand-authored surface (apps/sync-web/.../api-surface.ts)
 * once named `load` / `count` / `scope` — verbs/options that don't exist — with no
 * coupling to the code. The fix: the name lists live HERE, next to the types, and
 * each is proven EXACTLY equal to the keys of its source interface via
 * `Expect<Equal<…>>`. Add or remove a verb/option without updating the matching
 * tuple and THIS FILE FAILS TO COMPILE (the `Equal` constraint is checked eagerly
 * at the alias declaration — both directions: no phantom name, no missing name).
 *
 * Consumers (the MCP `get_api_surface`) import these NAME tuples and build their
 * prose from them, so a summary can never reference a verb that doesn't exist.
 * NAMES are guaranteed; descriptions stay hand-written (prose can't be type-checked).
 */

import type { ModelOperations, LocalReadOptions } from './client/createModelProxy.js';
import type { AbloOptions } from './client/Ablo.js';

// ── compile-time exact-equality (no runtime, no casts) ─────────────────────
// Standard invariant type-equality: true only when A and B are mutually assignable.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// `Expect<T extends true>` errors at the declaration when T is `false`.
type Expect<T extends true> = T;

// ── the per-`ablo.<model>` verb surface ────────────────────────────────────
/** Every method on `ablo.<model>` (the stateful `ModelOperations`). The single
 *  source of truth for the model-verb names the docs/MCP may describe. */
export const PUBLIC_MODEL_VERBS = [
  'retrieve',
  'list',
  'get',
  'getAll',
  'getCount',
  'create',
  'update',
  'delete',
  'claim',
  'watch',
  'onChange',
] as const;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ModelVerbsExact = Expect<
  Equal<(typeof PUBLIC_MODEL_VERBS)[number], keyof ModelOperations<unknown, unknown> & string>
>;

// ── the read/list query option surface ─────────────────────────────────────
/** Keys accepted by `list`/`getAll`/`onChange` options (`LocalReadOptions`).
 *  Note `state` (lifecycle filter) — NOT `scope` (a historic doc drift). */
export const PUBLIC_LIST_OPTION_KEYS = [
  'where',
  'filter',
  'orderBy',
  'limit',
  'offset',
  'state',
] as const;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ListOptionKeysExact = Expect<
  Equal<(typeof PUBLIC_LIST_OPTION_KEYS)[number], keyof LocalReadOptions<unknown> & string>
>;

// ── the `Ablo({ … })` constructor option surface ───────────────────────────
/** Public keys of `AbloOptions`. `schema` is required; the rest are optional
 *  (the locked happy path is `Ablo({ schema, apiKey, databaseUrl, transport })`). */
export const PUBLIC_ABLO_OPTION_KEYS = [
  'schema',
  'apiKey',
  'databaseUrl',
  'persistence',
  'transport',
  'authToken',
  'baseURL',
  'fetch',
  'defaultHeaders',
  'defaultQuery',
  'dangerouslyAllowBrowser',
] as const;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _AbloOptionKeysExact = Expect<
  Equal<(typeof PUBLIC_ABLO_OPTION_KEYS)[number], keyof AbloOptions & string>
>;

export type ModelVerb = (typeof PUBLIC_MODEL_VERBS)[number];
export type ListOptionKey = (typeof PUBLIC_LIST_OPTION_KEYS)[number];
export type AbloOptionKey = (typeof PUBLIC_ABLO_OPTION_KEYS)[number];
