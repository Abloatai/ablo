/**
 * Transport-driven PresenceStream factory.
 *
 * This is the engine's home for presence — built directly on
 * `SyncWebSocket`, no SyncAgent wrapper, no second connection. The
 * older compatibility path predates this and will be deleted when
 * the dual-engine collapse completes.
 *
 * Two construction modes:
 *
 *   1. Direct — pass `transport: SyncWebSocket` when it's already
 *      open (agent worker, tests).
 *   2. Deferred — pass `attachLater: true` and call `.attach(transport)`
 *      once the engine's WS lifecycle has produced one. The returned
 *      stream object is stable from construction; attachment can
 *      happen later without callers having to re-grab the reference.
 *
 * Wire contract (apps/sync-server/src/hub/types.ts):
 *   • Outbound: `{ type: 'presence_update', payload: { status, activity? } }`
 *     — server stamps `userId`, `kind`, `timestamp`, `isAgent` and
 *       broadcasts to other clients on the same sync groups.
 *   • Inbound:  same frame, with `kind: 'enter' | 'update' | 'leave'`.
 */

import type { SyncWebSocket, PresenceUpdateEvent } from './SyncWebSocket.js';
import type {
  Activity,
  Peer,
  PresenceStream,
  PresenceTarget,
} from '../types/streams.js';
import { asyncIteratorFrom } from '../utils/asyncIterator.js';

export interface PresenceStreamConfig {
  /** Identity used to filter our own echoed frames out of `others`. */
  participantId: string;
  /** Optional human label for the self entry. */
  label?: string;
  /** Sync groups the participant is broadcasting on. Used for the
   *  initial `self` entry and for `othersIn(...)` filtering. */
  syncGroups: readonly string[];
  /** Marks `self` as an agent. Server is the source of truth for
   *  peers' `isAgent`, but `self` is local — caller decides. */
  isAgent?: boolean;
}

/** PresenceStream extended with engine-lifecycle hooks. */
export interface AttachablePresenceStream extends PresenceStream {
  /** Wire the stream to a now-ready transport. Calls before this are
   *  buffered (self mutations only — no wire send). Idempotent. */
  attach(transport: SyncWebSocket): void;
  /** Tear down listeners. Stream object stays usable as a no-op. */
  dispose(): void;
}

export function createPresenceStream(
  config: PresenceStreamConfig,
  transport: SyncWebSocket | null = null,
): AttachablePresenceStream {
  const { participantId, label, syncGroups, isAgent = false } = config;

  // ── Self ─────────────────────────────────────────────────────────
  const self: Peer = {
    participantKind: isAgent ? 'agent' : 'human',
    participantId,
    label,
    syncGroups: [...syncGroups],
    activity: { entityType: 'Unknown', entityId: '', action: 'idle' },
    lastActive: new Date().toISOString(),
  };

  // ── Others ───────────────────────────────────────────────────────
  const othersById = new Map<string, Peer>();
  let othersSnapshot: ReadonlyArray<Peer> = Object.freeze([]);
  const listeners = new Set<() => void>();

  const notifyListeners = () => {
    othersSnapshot = Object.freeze(Array.from(othersById.values()));
    for (const l of listeners) {
      try {
        l();
      } catch {
        /* one bad listener doesn't break the others */
      }
    }
  };

  // ── Wire wiring ──────────────────────────────────────────────────
  let attached: SyncWebSocket | null = null;
  const unsubs: Array<() => void> = [];

  function attach(t: SyncWebSocket): void {
    if (attached) return; // idempotent
    attached = t;

    // Reconnect: clear roster (Hub sends fresh snapshot), re-announce
    // own activity (peers don't auto-learn about us across reconnects).
    unsubs.push(
      t.subscribe('connected', () => {
        if (othersById.size > 0) {
          othersById.clear();
          othersSnapshot = Object.freeze([]);
          notifyListeners();
        }
        if (self.activity.entityId) sendUpdate(self.activity);
      }),
    );

    // Inbound presence frames — translate the legacy wire vocabulary
    // (userId / isAgent / timestamp) into the engine shape
    // (participantId / participantKind / lastActive). When the server
    // adopts the engine names this block collapses to a pass-through.
    unsubs.push(
      t.subscribe('presence_update', (event: PresenceUpdateEvent) => {
        if (event.userId === participantId) return; // own echo
        if (!event.userId) return;

        switch (event.kind) {
          case 'leave':
            if (othersById.delete(event.userId)) notifyListeners();
            return;
          case 'enter':
          case 'update':
          case undefined: {
            const entry: Peer = {
              participantKind: event.isAgent ? 'agent' : 'human',
              participantId: event.userId,
              syncGroups: event.syncGroups ?? [],
              activity: event.activity
                ? {
                    entityType: event.activity.entityType,
                    entityId: event.activity.entityId,
                    path: event.activity.path,
                    range: event.activity.range,
                    field: event.activity.field,
                    meta: event.activity.meta,
                    action: event.activity.action,
                    detail: event.activity.detail,
                  }
                : { entityType: 'Unknown', entityId: '', action: event.status },
              lastActive: event.timestamp
                ? new Date(event.timestamp).toISOString()
                : new Date().toISOString(),
            };
            othersById.set(event.userId, entry);
            notifyListeners();
            return;
          }
        }
      }),
    );

    // If self was already mutated before attach, broadcast it now.
    if (self.activity.entityId) sendUpdate(self.activity);
  }

  if (transport) attach(transport);

  // ── Outbound ────────────────────────────────────────────────────
  // Note: do NOT include `isAgent` in the payload. Server derives it
  // authoritatively from the connection's identity prefix; clients
  // self-declaring `isAgent` caused human sessions to broadcast as
  // agents to peers (real bug we caught earlier).
  function sendUpdate(activity: Activity): void {
    if (!attached?.isConnected()) return; // no-op until connected
    attached.send({
      type: 'presence_update',
      payload: { status: 'online', activity },
    });
  }

  function doUpdate(activity: Activity): void {
    (self as { activity: Activity }).activity = activity;
    (self as { lastActive: string }).lastActive = new Date().toISOString();
    sendUpdate(activity);
  }

  function resolveTarget(target: PresenceTarget): Activity {
    if (Array.isArray(target)) {
      return { entityType: target[0], entityId: target[1], action: 'unknown' };
    }
    const obj = target as {
      type: string;
      id: string;
      path?: string;
      range?: Activity['range'];
      field?: string;
      meta?: Activity['meta'];
    };
    return {
      entityType: obj.type,
      entityId: obj.id,
      path: obj.path,
      range: obj.range,
      field: obj.field,
      meta: obj.meta,
      action: 'unknown',
    };
  }

  const withVerb =
    (action: string) =>
    (target: PresenceTarget, detail?: string): void => {
      doUpdate({ ...resolveTarget(target), action, detail });
    };

  return {
    self,
    update: doUpdate,
    editing: withVerb('editing'),
    reading: withVerb('reading'),
    viewing: withVerb('viewing'),
    idle: () => {
      doUpdate({ entityType: 'Unknown', entityId: '', action: 'idle' });
    },
    get others() {
      return othersSnapshot;
    },
    othersIn: (syncGroup: string) =>
      othersSnapshot.filter((e) => e.syncGroups.includes(syncGroup)),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [Symbol.asyncIterator]() {
      return asyncIteratorFrom<ReadonlyArray<Peer>>(
        (onChange) => {
          listeners.add(onChange);
          return () => {
            listeners.delete(onChange);
          };
        },
        () => othersSnapshot,
      );
    },
    attach,
    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      listeners.clear();
      othersById.clear();
      othersSnapshot = Object.freeze([]);
      attached = null;
    },
  };
}
