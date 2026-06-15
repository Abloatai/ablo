'use client';

import { useCallback } from 'react';
import { useSyncContext } from './context.js';
import type { ResolveClaims } from '../types/global.js';
import { AbloValidationError } from '../errors.js';

/**
 * Named-claim invoker, typed via `ResolveClaims[ClaimName]`.
 *
 * The consumer declares their claim vocabulary in the global:
 *
 * ```ts
 * declare module '@abloatai/ablo' {
 *   interface Register {
 *     Claims: {
 *       editLayer: { slideId: string; layerId: string };
 *       generateWithAI: { entityId: string; tool: string };
 *     };
 *   }
 * }
 * ```
 *
 * Then `useClaim('editLayer')` returns a function whose sole argument
 * is the `editLayer` claim shape — no runtime checks, purely compile-
 * time narrowing.
 *
 * The SDK doesn't own what happens next: the `beginClaim` function on
 * the React context (supplied via `SyncProvider`) is where the claim
 * claim turns into a network effect. A Node-backed consumer wires it
 * through `SyncAgent.beginClaim`; a browser-backed consumer may
 * broadcast it through their own WebSocket. This hook is pure sugar
 * that adds the typed name + claim narrowing.
 */
export function useClaim<Name extends keyof ResolveClaims & string>(
  claimName: Name,
): (claim: ResolveClaims[Name]) => unknown {
  const { beginClaim } = useSyncContext();
  return useCallback(
    (claim: ResolveClaims[Name]) => {
      if (!beginClaim) {
        throw new AbloValidationError(
          `useClaim: no \`beginClaim\` wired into SyncProvider. Pass ` +
            `a \`beginClaim\` prop (typically bound to your transport) ` +
            `to enable claim invocations.`,
          { code: 'claim_not_wired' },
        );
      }
      return beginClaim(claimName, claim);
    },
    [beginClaim, claimName],
  );
}
