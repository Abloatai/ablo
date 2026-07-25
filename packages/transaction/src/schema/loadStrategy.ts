/**
 * When a model's rows are loaded from the server.
 *
 *   - `instant` — loaded during bootstrap, before the model is first used.
 *   - `lazy`    — loaded all at once on first access.
 *
 * One declaration serves both sides of the seam. `LoadStrategy.instant` is the
 * value the engine branches on once a model is registered; `'instant'` is the
 * word an author writes in `model(…, { load })`. They are the same name because
 * they are the same axis — a const object merged with the type of its own
 * values, rather than an enum, because a string enum is nominal and would
 * refuse the plain `'instant'` an author actually types.
 *
 * The set is deliberately this small. It previously named `partial`,
 * `explicitlyRequested`, and `local` on the runtime side and `manual` on the
 * authoring side, and not one of those was reachable end to end: `manual` had
 * no implementation and resolved to `lazy`, while the other three had no way to
 * be declared. A member no schema can produce, or no branch can observe, is a
 * promise the engine has no way to keep.
 */

export const LoadStrategy = {
  /** Loaded during startup, before it is first used — for models needed right away. */
  instant: 'instant',

  /** Loaded all at once the first time it is needed — for secondary models. */
  lazy: 'lazy',
} as const;

export type LoadStrategy = (typeof LoadStrategy)[keyof typeof LoadStrategy];

/** The strategy a model gets when it declares none. */
export const DEFAULT_LOAD_STRATEGY: LoadStrategy = LoadStrategy.instant;

/**
 * Whether a model's rows arrive in the bootstrap payload rather than on first
 * access. This is the question the client asks when it builds the bootstrap
 * subscription and the question the server asks when it assembles the payload,
 * and the two must answer it identically or a model is requested by one side
 * and withheld by the other.
 *
 * It is a function rather than a comparison spelled at each site because the
 * sites disagreed about how to spell it: one asked `load !== 'lazy'`, another
 * `load === 'instant'`, a third `load === 'lazy' ? … : …`. Against a two-member
 * set those are the same predicate, so nothing failed. Against a third member
 * they are three different predicates, and the first would have enrolled it in
 * bootstrap while the second withheld it — the kind of split that surfaces as
 * rows that never arrive, far from the line that caused it.
 */
export function loadsAtBootstrap(load: LoadStrategy | undefined): boolean {
  return (load ?? DEFAULT_LOAD_STRATEGY) === LoadStrategy.instant;
}
