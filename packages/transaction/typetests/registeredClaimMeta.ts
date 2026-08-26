/**
 * The proof that registering `ClaimMeta` types a claim end to end.
 *
 * An application declares its claim metadata once — `interface Register {
 * ClaimMeta }` — and from then on both halves of a claim read as that shape:
 * what it may write into a target's `meta`, and what it is handed back off any
 * claim it observes. Nothing else in the repo can show this. A `Register`
 * augmentation merges across a whole compilation, so the package's main program
 * would have every wire-shaped claim fixture in it retyped by the declaration;
 * this file therefore lives in its own `tsc` program (`npm run
 * typecheck:types`), where the declaration is the point.
 *
 * The assertions are the type declarations themselves. There is no runtime and
 * no test runner — the gate is that `tsc` accepts this file, and that the one
 * `@ts-expect-error` below still has an error to expect.
 *
 * An application augments `'@abloatai/ablo'`, the published name. Inside the
 * repo that specifier resolves to nothing, and augmenting an unresolved module
 * quietly declares a new ambient one that merges with nothing — so this
 * augments the module that declares `Register` directly.
 */

import type { ResolveClaimMeta } from '@abloatai/transaction/types/global';
import type { Claim, ClaimTarget, HeldClaim } from '@abloatai/transaction/types/streams';
import type { ClaimTargetOptions } from '@abloatai/transaction/client/resources/modelOperations';
import type { ClaimCreateOptions } from '@abloatai/transaction/client/resources/httpResources';
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
// Deep, and on purpose. Naming the two modules that carry a claim between the
// wire and the declared shape puts them in this program, so the registration
// below type-checks the SDK's own paths and not only its published types. They
// used to compile because nothing anywhere registered a `ClaimMeta`; this is
// what says they still compile when something does.
import type { createHttpTransport } from '@abloatai/transaction/transport/http';

/**
 * The shape a program would register. An `interface` on purpose: it is the
 * spelling with no implicit index signature, so it is the one a conversion to
 * the wire's open record cannot silently absorb.
 */
interface ReviewMeta {
  blocks: string[];
  reviewer?: string;
}

declare module '@abloatai/transaction/types/global' {
  interface Register {
    ClaimMeta: ReviewMeta;
  }
}

/** The reference that keeps the two crossing modules above in this program. */
export type CrossingModules = [typeof createHttpTransport];

// ── The registration reaches the resolver ────────────────────────────────

export const resolverIsTheRegistration: Identical<ResolveClaimMeta, ReviewMeta> =
  true;

// ── … and both surfaces of a claim ───────────────────────────────────────
// Invariant equality, so a surface that widens back to a bare record fails
// here rather than passing on assignability.

export const writeSurfaceIsTheRegistration: Identical<
  NonNullable<ClaimTargetOptions['meta']>,
  ReviewMeta
> = true;

export const createSurfaceIsTheRegistration: Identical<
  NonNullable<ClaimCreateOptions['target']['meta']>,
  ReviewMeta
> = true;

export const readSurfaceIsTheRegistration: Identical<
  NonNullable<ClaimTarget['meta']>,
  ReviewMeta
> = true;

export const claimReadsTheRegistration: Identical<
  NonNullable<Claim['target']['meta']>,
  ReviewMeta
> = true;

export const heldClaimReadsTheRegistration: Identical<
  NonNullable<HeldClaim['target']['meta']>,
  ReviewMeta
> = true;

// ── What that buys at a call site ────────────────────────────────────────

declare const observed: Claim;
/** No `typeof` guard, no cast: the declaration is what makes this compile. */
export const observedBlocks: string[] | undefined = observed.target.meta?.blocks;

export const claimToCreate: ClaimCreateOptions = {
  target: { model: 'reviews', id: 'rev_1', meta: { blocks: ['b_1'] } },
};

export const claimToTake: ClaimTargetOptions = {
  description: 'rewriting the risk section',
  meta: { blocks: ['b_1'], reviewer: 'u_7' },
};

// The other half of the promise: a shape the reader was told cannot exist may
// not be written. Without the registration this literal is legal, which is why
// the directive belongs in this program and nowhere else.
export const misspelledMeta: ClaimTargetOptions = {
  // @ts-expect-error `blokcs` is not a member of the registered ClaimMeta
  meta: { blokcs: ['b_1'] },
};
