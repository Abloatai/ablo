'use client';

import { useSyncContext } from './context.js';
import type { ResolvePresence } from '../types/global.js';

/**
 * Read the consumer-supplied presence state with `ResolvePresence`d
 * typing — the shape the consumer declared in
 * `declare global { interface AbloSync { Presence: ... } }`.
 *
 * The SDK doesn't own a presence wire format. Consumers plug whatever
 * backs their cursors, status, or activity (a MobX store, a custom
 * WebSocket channel, `SyncAgent` in Node, a Zustand slice) via the
 * `presence` prop on `SyncProvider`. This hook returns it typed.
 *
 * ```ts
 * // apps/your-app/src/ablo-sync.d.ts
 * declare global {
 *   interface AbloSync {
 *     Presence: { cursor: { x: number; y: number } | null; status: 'away' | 'online' };
 *   }
 * }
 *
 * // consumer's <SyncProvider> wiring
 * <SyncProvider store={store} organizationId={orgId} presence={presenceStore}>
 *
 * // any component
 * const presence = usePresence();
 * presence?.cursor?.x; // fully typed
 * ```
 *
 * Returns `undefined` when no provider-level presence source is wired —
 * consumers can narrow with a guard or configure a default in their
 * provider.
 */
export function usePresence(): ResolvePresence | undefined {
  const ctx = useSyncContext();
  // The runtime value is whatever the consumer passed to `SyncProvider`.
  // The type assertion reflects the consumer's declared global, which
  // the hook can't verify at runtime — but the consumer controls both
  // ends (the global declaration and the provider prop) so this is a
  // single-source-of-truth contract, not blind trust.
  return ctx.presence as ResolvePresence | undefined;
}
