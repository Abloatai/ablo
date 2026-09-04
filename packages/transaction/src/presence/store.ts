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

/** One connection-owned projection shared by session and model presence. */
export interface PresenceProjection extends PresenceView {
  readonly sessions: readonly PresenceSession[];
  forModel(model: string, recordId?: string): readonly PresenceSession[];
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createPresenceProjection(events: PresenceProjectionEvents): PresenceProjection {
  let currentPresenceSessionId: string | null = null;
  const snapshots = new Map<string, PresenceSnapshot>();
  const listeners = new Set<() => void>();
  const unsubscribers: Array<() => void> = [];
  let sessionSnapshot: readonly PresenceSession[] = Object.freeze([]);
  let othersSnapshot: readonly PresenceSession[] = Object.freeze([]);

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

  const clear = (): void => {
    if (snapshots.size === 0) return;
    snapshots.clear();
    notify();
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
    events.subscribe('connected', clear),
    events.subscribe('disconnected', clear),
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
    forModel(model, recordId) {
      return recordId === undefined
        ? presenceForModel(sessionSnapshot, model)
        : presenceForRecord(sessionSnapshot, model, recordId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose() {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      listeners.clear();
      snapshots.clear();
      rebuild();
    },
  };
}
