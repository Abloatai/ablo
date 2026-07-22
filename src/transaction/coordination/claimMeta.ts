/**
 * A claim's application metadata, crossing between the wire and the shape the
 * program declared for it.
 *
 * The wire contract for `meta` is deliberately permissive — `targetRefSchema`
 * parses it as `z.record(z.string(), z.unknown())` and always will, because a
 * newer peer must be able to send a field this build has never heard of and
 * still be understood. The read surface is the opposite: `Register`'s
 * `ClaimMeta` slot names the one shape this program's claims carry, so
 * `claim.state({ id })?.target.meta` reads without a guard.
 *
 * Those two facts meet here, and only here, in both directions. A decode calls
 * {@link declaredMeta} on its way from a parsed record to a public `Claim`; the
 * locator projection calls {@link wireMeta} on the way back out, where a
 * caller's declared value is put on the socket or in the HTTP body. Between
 * them they are the one place the SDK takes the caller's word for a shape it
 * did not check — written down once, with the reason, instead of being asserted
 * at each crossing.
 *
 * The two directions are not symmetric in cost. Losing the declared shape on
 * the way out is harmless, because the wire has always accepted any record;
 * gaining it on the way in is the promise the read surface makes, so
 * `declaredMeta` is the one to audit when a claim reads back a shape its holder
 * never wrote.
 */

import type { ResolveClaimMeta } from '../types/global.js';

/**
 * Read a parsed `meta` as the declared shape. Call it only where a decode hands
 * a wire value to a public claim, and only for a value already known present —
 * the absent case is an omitted member, not a declared-shaped `undefined`.
 *
 * The exported names are `declaredMeta` and `wireMeta` rather than a `claimMeta`
 * pair because two claim surfaces already read a caller's `meta` back off the
 * options it passed in, and spell that local reader `claimMeta`.
 */
export function declaredMeta(raw: unknown): ResolveClaimMeta {
  return raw as ResolveClaimMeta;
}

/**
 * Write a declared `meta` as the permissive record the wire carries. Every path
 * from a caller's target to a frame or request body goes through `subTarget`,
 * so this has exactly one caller — widening it is how the declared shape stops
 * being a compile error at the edge of the protocol instead of stopping there.
 *
 * The parameter is `unknown` rather than {@link ResolveClaimMeta} on purpose: a
 * program may register an `interface` for its claim metadata, and an interface
 * carries no implicit index signature, so a directly-typed parameter would make
 * the conversion itself unrepresentable at the one site that needs it. Widening
 * the input is what keeps the assertion single.
 */
export function wireMeta(meta: unknown): Record<string, unknown> {
  return meta as Record<string, unknown>;
}
