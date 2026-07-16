/**
 * A machine-checked manifest of this package's public API surface. It lists,
 * as string tuples, the method names on `ablo.<model>`, the keys accepted by
 * the list-style read options, and the keys of the client constructor
 * options. Each tuple is proven equal to the keys of its source interface at
 * compile time, so the lists cannot drift from the real types: add or remove
 * a name on either side without updating the matching tuple and this file
 * fails to compile, in both directions — no name the interface lacks, and no
 * interface key the tuple omits.
 *
 * Documentation tooling reads these tuples to describe the surface, which
 * guarantees a generated summary never names a method or option that does
 * not exist. The names are verified here; their prose descriptions are
 * written by hand, since prose cannot be type-checked.
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
/**
 * The names of every method available on `ablo.<model>`, matching the keys of
 * the {@link ModelOperations} interface. Documentation tooling reads this
 * tuple, so it is the one list of model-verb names a generated summary can
 * describe.
 */
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
  'track',
  'join',
  'onChange',
] as const;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ModelVerbsExact = Expect<
  Equal<(typeof PUBLIC_MODEL_VERBS)[number], keyof ModelOperations<unknown, unknown> & string>
>;

// ── the read/list query option surface ─────────────────────────────────────
/**
 * The option keys accepted by `list`, `getAll`, and `onChange`, matching the
 * keys of {@link LocalReadOptions}. Note that the lifecycle filter is named
 * `state`, not `scope`.
 */
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
/**
 * The keys of the client constructor options, {@link AbloOptions}. Only
 * `schema` is required; every other key is optional.
 */
export const PUBLIC_ABLO_OPTION_KEYS = [
  'schema',
  'apiKey',
  'authEndpoint',
  'persistence',
  'durableWrites',
  'commitOutbox',
  'commitOutboxScope',
  'transport',
  'debug',
  'logLevel',
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
