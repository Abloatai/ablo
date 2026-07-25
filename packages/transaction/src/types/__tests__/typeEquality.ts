/**
 * Invariant type equality for compile-time contract assertions.
 *
 * A one-way `extends` check permits accidental widening and degrades when
 * either side is `any`; comparing the two generic call signatures does not.
 */
export type Identical<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
