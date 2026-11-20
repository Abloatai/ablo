import type { PresenceActivity, PresenceSession } from './contract.js';
import {
  applyPresencePatch,
  applyPresenceSnapshot,
  presenceForModel,
  presenceForRecord,
} from './projection.js';
import type { PresencePatch, PresenceSnapshot } from './projections.js';

export interface PresenceProjectionEvents {
  subscribe(event: 'presence_session', listener: (event: {
    readonly presenceSessionId: string;
  }) => void): () => void;
  subscribe(event: 'presence_snapshot', listener: (snapshot: PresenceSnapshot) => void): () => void;
  subscribe(event: 'presence_patch', listener: (patch: PresencePatch) => void): () => void;
  subscribe(event: 'connected' | 'disconnected', listener: () => void): () => void;
}

/** The complete public session view. Protocol bookkeeping stays internal. */
export interface PresenceView {
  readonly active: readonly PresenceActivity[];
  readonly others: readonly PresenceSession[];
}

export interface PresenceQueryOptions {
  /** Exclude the current session, retaining other sessions of the same participant. */
  readonly excludeSelf?: boolean;
}

/** One connection-owned projection shared by session and model presence. */
export interface PresenceProjection extends PresenceView {
  readonly sessions: readonly PresenceSession[];
  forModel(model: string, recordId?: string, options?: PresenceQueryOptions): readonly PresenceSession[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

/**
 * How long to keep showing the last-known roster after the socket reports
 * `disconnected` before actually clearing it. The transport emits that event
 * on every drop, including brief blips — its own reconnect backoff starts at
 * 1s and doubles from there (see `transport.ts`). Clearing immediately means a
 * one-second network hiccup wipes every participant's avatar and then
 * repopulates it moments later on `presence_snapshot`, which reads as
 * flicker rather than a real departure, and it happens to everyone else's
 * presence too, not just the local session's. Deferring the clear and
 * cancelling it on `connected` rides out ordinary reconnects silently; a
 * connection that stays down past the grace window still clears, same as
 * before. The server's own `LEASE_TTL_MS` (packages/transaction/src/wire/
 * protocol.ts) is the authoritative timeout for a genuinely gone session —
 * this is only about not flashing the UI empty during routine reconnects.
 */
const DISCONNECT_CLEAR_GRACE_MS = 5_000;

export function createPresenceProjection(events: PresenceProjectionEvents): PresenceProjection {
  let currentPresenceSessionId: string | null = null;
  const snapshots = new Map<string, PresenceSnapshot>();
  const listeners = new Set<() => void>();
  const unsubscribers: Array<() => void> = [];
  let sessionSnapshot: readonly PresenceSession[] = Object.freeze([]);
  let othersSnapshot: readonly PresenceSession[] = Object.freeze([]);
  let pendingClear: ReturnType<typeof setTimeout> | null = null;

  const rebuild = (): void => {
    sessionSnapshot = Object.freeze(
      [...snapshots.values()]
        .filter((snapshot) => snapshot.activities.length > 0)
        .map(({ presenceSessionId, participant, activities }) => ({
          presenceSessionId,
          participant,
          activities,
        }))
        .sort((left, right) => left.presenceSessionId.localeCompare(right.presenceSessionId)),
    );
    othersSnapshot = Object.freeze(sessionSnapshot.filter(
      (session) => session.presenceSessionId !== currentPresenceSessionId,
    ));
  };

  const notify = (): void => {
    rebuild();
    for (const listener of listeners) {
      try { listener(); } catch { /* one consumer cannot stop projection updates */ }
    }
  };

  const cancelPendingClear = (): void => {
    if (pendingClear === null) return;
    clearTimeout(pendingClear);
    pendingClear = null;
  };

  const clear = (): void => {
    cancelPendingClear();
    if (snapshots.size === 0) return;
    snapshots.clear();
    notify();
  };

  const scheduleClear = (): void => {
    cancelPendingClear();
    pendingClear = setTimeout(clear, DISCONNECT_CLEAR_GRACE_MS);
  };

  unsubscribers.push(
    events.subscribe('presence_session', ({ presenceSessionId }) => {
      currentPresenceSessionId = presenceSessionId;
      notify();
    }),
    events.subscribe('presence_snapshot', (incoming) => {
      const current = snapshots.get(incoming.presenceSessionId);
      const next = applyPresenceSnapshot(current, incoming);
      if (next === current) return;
      snapshots.set(incoming.presenceSessionId, next);
      notify();
    }),
    events.subscribe('presence_patch', (patch) => {
      const current = snapshots.get(patch.presenceSessionId);
      if (current === undefined && patch.participant === undefined) return;
      const participant = current?.participant ?? patch.participant;
      if (participant === undefined) return;
      const initial: PresenceSnapshot = current ?? {
        presenceSessionId: patch.presenceSessionId,
        participant,
        revision: 0,
        activities: [],
        tombstones: [],
      };
      snapshots.set(patch.presenceSessionId, applyPresencePatch(initial, patch));
      notify();
    }),
    events.subscribe('connected', cancelPendingClear),
    events.subscribe('disconnected', scheduleClear),
  );

  return {
    get active() {
      if (currentPresenceSessionId === null) return [];
      return snapshots.get(currentPresenceSessionId)?.activities ?? [];
    },
    get others() {
      return othersSnapshot;
    },
    get sessions() {
      return sessionSnapshot;
    },
    forModel(model, recordId, options) {
      const sessions = options?.excludeSelf ? othersSnapshot : sessionSnapshot;
      return recordId === undefined
        ? presenceForModel(sessions, model)
        : presenceForRecord(sessions, model, recordId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      cancelPendingClear();
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      listeners.clear();
      snapshots.clear();
      rebuild();
    },
  };
}
