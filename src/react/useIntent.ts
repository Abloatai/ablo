'use client';

import { useCallback } from 'react';
import { useSyncContext } from './context';
import type { ResolveIntents } from '../types/global';
import { AbloValidationError } from '../errors';

/**
 * Named-intent invoker, typed via `ResolveIntents[IntentName]`.
 *
 * The consumer declares their intent vocabulary in the global:
 *
 * ```ts
 * declare global {
 *   interface AbloSync {
 *     Intents: {
 *       editLayer: { slideId: string; layerId: string };
 *       generateWithAI: { entityId: string; tool: string };
 *     };
 *   }
 * }
 * ```
 *
 * Then `useIntent('editLayer')` returns a function whose sole argument
 * is the `editLayer` claim shape — no runtime checks, purely compile-
 * time narrowing.
 *
 * The SDK doesn't own what happens next: the `beginIntent` function on
 * the React context (supplied via `SyncProvider`) is where the intent
 * claim turns into a network effect. A Node-backed consumer wires it
 * through `SyncAgent.beginIntent`; a browser-backed consumer may
 * broadcast it through their own WebSocket. This hook is pure sugar
 * that adds the typed name + claim narrowing.
 */
export function useIntent<Name extends keyof ResolveIntents & string>(
  intentName: Name,
): (claim: ResolveIntents[Name]) => unknown {
  const { beginIntent } = useSyncContext();
  return useCallback(
    (claim: ResolveIntents[Name]) => {
      if (!beginIntent) {
        throw new AbloValidationError(
          `useIntent: no \`beginIntent\` wired into SyncProvider. Pass ` +
            `a \`beginIntent\` prop (typically bound to your transport) ` +
            `to enable intent invocations.`,
          { code: 'intent_not_wired' },
        );
      }
      return beginIntent(intentName, claim);
    },
    [beginIntent, intentName],
  );
}
