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

import type { WsTransport } from '@abloatai/transaction/transport/websocket';
import type { PresenceUpdate } from '@abloatai/transaction/transport/websocket';
import type {
  Activity,
  Peer,
  PresenceStream,
  PresenceTarget,
} from '@abloatai/transaction/types/streams';

import { asyncIteratorFrom } from '@abloatai/transaction/utils/asyncIterator';
import { participantKindFromWire } from '@abloatai/transaction/coordination/schema';
import { isTargetTuple, subTarget, wireTarget } from '@abloatai/transaction/coordination';
import type { ParticipantKind } from '@abloatai/transaction/types/participant';

/**
 * The wire capability the presence stream actually uses: subscribe to typed
 * inbound frames, check liveness, and send outbound frames. The duplex
 * `WsTransport` satisfies it — the same port shape the claim stream depends
 * on — so the stream can attach to whatever connection the host built,
 * without naming the engine's subclass.
 */
export type PresenceTransport = Pick<WsTransport, 'subscribe' | 'isConnected' | 'send'>;

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
  attach(transport: PresenceTransport): void;
  /**
   * Seeds the participant identity once the host resolves it. The stream can
   * be built before identity is known — a hosted client learns who it is
   * from its credential's scope during connect — and until then the
   * construction-time values (possibly empty) would leave the `self` entry
   * blank and let the participant's own echoed frames into `others`. Updates
   * the `self` entry in place, so held references see the resolved identity.
   */
  setParticipant(participant: {
    id: string;
    kind?: ParticipantKind;
    syncGroups?: readonly string[];
  }): void;
  /** Tear down listeners. Stream object stays usable as a no-op. */
  dispose(): void;
}

export function createPresenceStream(
  config: PresenceStreamConfig,
  transport: PresenceTransport | null = null,
): AttachablePresenceStream {
  const { label, syncGroups, isAgent = false } = config;
  // Mutable: the host seeds the resolved identity via `setParticipant` once
  // it is known; the own-echo filter always reads the current value.
  let participantId = config.participantId;

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
  let attached: PresenceTransport | null = null;
  const unsubs: (() => void)[] = [];

  function attach(t: PresenceTransport): void {
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
      t.subscribe('presence_update', (event: PresenceUpdate) => {
        if (event.userId === participantId) return; // own echo
        if (!event.userId) return;

        switch (event.kind) {
          case 'leave':
            if (othersById.delete(event.userId)) notifyListeners();
            return;
          // No `undefined` arm: every site that builds a presence frame stamps
          // `kind`, and the schema now says so, so an unlabelled frame is not a
          // shape the transport can hand us.
          case 'enter':
          case 'update': {
            const entry: Peer = {
              participantKind: participantKindFromWire(
                event.participantKind,
                event.isAgent,
              ),
              participantId: event.userId,
              syncGroups: event.syncGroups ?? [],
              activity: event.activity
                ? {
                    ...wireTarget(event.activity),
                    ...subTarget(event.activity),
                    action: event.activity.action,
                    ...(event.activity.detail !== undefined
                      ? { detail: event.activity.detail }
                      : {}),
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
    if (isTargetTuple(target)) {
      return { entityType: target[0], entityId: target[1], action: 'unknown' };
    }
    return {
      ...wireTarget(target),
      ...subTarget(target),
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
    setParticipant(participant): void {
      participantId = participant.id;
      const writable = self as {
        participantId: string;
        participantKind: Peer['participantKind'];
        syncGroups: readonly string[];
      };
      writable.participantId = participant.id;
      if (participant.kind) writable.participantKind = participant.kind;
      if (participant.syncGroups) writable.syncGroups = [...participant.syncGroups];
    },
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
