/**
 * Invariant type equality, for gates that must fail on a *wider* answer.
 *
 * `A extends B ? true : false` passes for anything assignable, so it holds when
 * a declaration is quietly widened — and it degenerates to `boolean` when either
 * side is `any`, which then satisfies an assertion written as `const ok: T =
 * true`. Both are exactly the regressions the claim-metadata and register gates
 * exist to catch, so they compare with this instead.
 *
 * The two-function-signature trick is the standard way to ask TypeScript for
 * invariance: two conditional types are only mutually assignable when their
 * check types are identical, `any` included.
 *
 * Not a test file (no `.test.ts` suffix, so jest never collects it) — it is the
 * one definition of this helper, shared by the resolver gate in this directory
 * and by the registered-ClaimMeta fixture in `typetests/`, which runs in its own
 * `tsc` program.
 */

// Each `T` is read once on purpose — that is what makes the two signatures
// invariant in `A` and `B`, and it is the whole check. Naming it once per
// signature is not an accident to be tidied away; deleting either parameter
// collapses this back into the assignability test described above.
export type Identical<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- see above
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
