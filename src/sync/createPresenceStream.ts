/**
 * Creates a {@link PresenceStream} over a live sync connection. Presence is the
 * lightweight, ephemeral "who's here and what are they doing" view: each
 * participant broadcasts a status and an activity, and sees everyone else's.
 * The stream is built directly on the sync WebSocket and adds no second
 * connection. It is the sibling of {@link createClaimStream}, which reuses the
 * same presence frames.
 *
 * There are two ways to construct it:
 *
 *   1. Direct — pass an already-open `transport`, for example an agent worker
 *      or a test.
 *   2. Deferred — construct without a transport and call `attach(transport)`
 *      once the connection is ready. The returned stream object is stable from
 *      construction, so callers can hold the reference and let attachment
 *      happen later.
 *
 * Wire frames:
 *   • Outbound `presence_update` — `{ status, activity? }`. The server stamps
 *       `userId`, `kind`, `timestamp`, and `isAgent`, then broadcasts to the
 *       other participants on the same sync groups.
 *   • Inbound — the same frame, with `kind` one of `enter`, `update`, or
 *       `leave`.
 */

import type { SyncWebSocket, PresenceUpdateEvent } from './SyncWebSocket.js';
import type {
  Activity,
  Peer,
  PresenceStream,
  PresenceTarget,
} from '../types/streams.js';
import { asyncIteratorFrom } from '../utils/asyncIterator.js';
import { participantKindFromWire } from '../coordination/schema.js';

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
    participantKind: isAgent ? 'agent' : 'user',
    participantId,
    label,
    syncGroups: [...syncGroups],
    activity: { entityType: 'Unknown', entityId: '', action: 'idle' },
    lastActive: new Date().toISOString(),
  };

  // ── Others ───────────────────────────────────────────────────────
  const othersById = new Map<string, Peer>();
  let othersSnapshot: readonly Peer[] = Object.freeze([]);
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
  const unsubs: (() => void)[] = [];

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

    // Inbound presence frames arrive in the wire vocabulary
    // (userId / isAgent / timestamp); translate them into the shape this
    // stream exposes (participantId / participantKind / lastActive).
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
              participantKind: participantKindFromWire(
                event.participantKind,
                event.isAgent,
              ),
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
  // Do not include `isAgent` in the payload. The server derives it
  // authoritatively from the connection's identity, and letting a client
  // self-declare it once caused human sessions to broadcast as agents to peers.
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
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [Symbol.asyncIterator]() {
      return asyncIteratorFrom<readonly Peer[]>(
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
