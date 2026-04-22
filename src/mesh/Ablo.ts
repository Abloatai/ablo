/**
 * `Ablo` — the canonical class surface.
 *
 * ```ts
 * import Ablo from '@ablo/sync-engine';
 * import { schema } from './my-schema';
 *
 * const ablo = new Ablo({ schema });
 * ```
 *
 * Wraps `createMesh(...)` with the package-name → class-name parity
 * every mainstream SDK ships: `new Stripe(key)`, `new OpenAI()`,
 * `new Anthropic()`. Behaviorally identical — the class constructor
 * returns the `AbloClient` instance, so `new Ablo(opts)` and
 * `createMesh(opts)` are observationally indistinguishable at
 * runtime. TypeScript sees the class / interface merge below so
 * `ablo.join(...)`, `ablo.admin.capabilities.create(...)`, etc. type-check
 * against the full `AbloClient<S>` surface.
 *
 * The factory function stays exported for callers who prefer
 * functional style (or for environments where `new` is awkward, like
 * certain DI containers). Both reach the same implementation.
 */

import type { Schema } from '../schema/schema';
import { createMesh } from './createMesh';
import type { CreateMeshOptions, AbloClient } from './api';

// `Ablo<S>` is the instance shape. `AbloClient<S>` is an intersection
// type (`AbloClientBase & ScopedJoiners`), and an `interface` can't
// `extend` an intersection — so we use a type alias plus a value
// declaration. TypeScript merges the two under the same name: `Ablo`
// as a type refers to the alias, `Ablo` as a value refers to the
// constructor.
export type Ablo<S extends Schema = Schema> = AbloClient<S>;

// The class body returns from the constructor, which makes `new Ablo`
// resolve to the `createMesh` output (legal since ES6 — same pattern
// Node's `Buffer`, Bun's `Response` use). The outer cast narrows the
// public signature to a clean `new <S>(opts) => Ablo<S>` so TypeScript
// doesn't surface the class internals.
// eslint-disable-next-line @typescript-eslint/no-redeclare
export const Ablo = class AbloImpl<S extends Schema> {
  constructor(options: CreateMeshOptions<S>) {
    return createMesh(options) as unknown as AbloClient<S>;
  }
} as new <S extends Schema = Schema>(options: CreateMeshOptions<S>) => Ablo<S>;
