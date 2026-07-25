/**
 * Wire-contract snapshot (production-proof plan Phase 3).
 *
 * The error-code registry (`errorCodes.ts`) is a PUBLISHED wire contract:
 * customer agents pin old SDK versions and branch on `httpStatus` (routing),
 * `retryable` (retry loops), `category`, and `surface` (does it cross the
 * network at all). A silent change to any of those — the kind that slipped in
 * three times this week via bulk renames — changes behavior for every pinned
 * SDK without a compile error anywhere.
 *
 * This snapshot freezes the contract-relevant projection of every code:
 * `{ category, surface, httpStatus, retryable }`. The human-readable `message`
 * and the `recovery` hint are deliberately EXCLUDED — message wording is
 * allowed to improve freely, and `recovery` is derived. Changing a frozen
 * field fails here: intentional changes update the snapshot in the same PR
 * (a reviewable diff), and bump `ERROR_CONTRACT_VERSION` when the change is
 * breaking. Adding a NEW code just adds a line — additive, non-breaking.
 *
 * Pins the SOURCE registry (not the dist entry) so it guards the contract even
 * when the local build is stale.
 */
import { ERROR_CODES, ERROR_CONTRACT_VERSION, type ErrorCodeSpec } from '@abloatai/transaction/errorCodes';

/** The contract-relevant projection — the fields an old SDK actually branches
 *  on. `message`/`recovery` intentionally omitted (see file header). */
function contractShape(spec: ErrorCodeSpec) {
  return {
    category: spec.category,
    surface: spec.surface,
    httpStatus: spec.httpStatus ?? null,
    retryable: spec.retryable,
  };
}

describe('error-code wire contract snapshot', () => {
  it('every code has a category and a coherent wire/client shape', () => {
    // Structural invariants the snapshot itself can't express: a `wire` code
    // MUST carry an httpStatus (it hits the network); a `client` code MUST NOT
    // (it never serializes). A drift here is a contract bug regardless of the
    // snapshot.
    // `code` is folded into the asserted value (jest's `expect` takes no
    // per-assertion message) so a failure names the offending code.
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      if (spec.surface === 'wire') {
        expect({ code, hasStatus: typeof spec.httpStatus === 'number' }).toEqual({ code, hasStatus: true });
      } else {
        expect({ code, httpStatus: spec.httpStatus }).toEqual({ code, httpStatus: undefined });
      }
    }
  });

  it('the (category, surface, httpStatus, retryable) contract is frozen', () => {
    // Deterministic ordering so the snapshot diff is stable and reviewable.
    const frozen = Object.fromEntries(
      Object.keys(ERROR_CODES)
        .sort()
        .map((code) => [code, contractShape(ERROR_CODES[code as keyof typeof ERROR_CODES])]),
    );
    expect({ version: ERROR_CONTRACT_VERSION, codes: frozen }).toMatchSnapshot();
  });
});
