/**
 * Transport-driven IntentStream factory.
 *
 * Mirrors `createPresenceStream` — built directly on `SyncWebSocket`,
 * no SyncAgent wrapper. Intents derive their `others` view from the
 * same `presence_update` frames the presence stream consumes (the
 * Hub piggybacks `activeIntents` on every presence frame). Outbound
 * announce/revoke ride the same socket via `intent_begin` /
 * `intent_abandon` frames.
 *
 * Wire contract (apps/sync-server/src/hub/types.ts):
 *   • Outbound: `{ type: 'intent_begin', payload: { intentId,
 *       entityType, entityId, action, field?, estimatedMs? } }`
 *   • Outbound: `{ type: 'intent_abandon', payload: { intentId } }`
 *   • Inbound (via presence): `event.activeIntents: IntentClaim[]`
 *     stamped with `declaredAt`, `expiresAt`.
 *   • Inbound: `intent_rejected` event with conflict metadata.
 *
 * After the dual-engine collapse (step #36), this is the only
 * IntentStream factory in the SDK; the older compatibility path
 * deletes.
 */

import type {
  SyncWebSocket,
  PresenceUpdateEvent,
} from './SyncWebSocket.js';
import type {
  ActiveIntent,
  EntityRef,
  Claim,
  IntentOptions,
  IntentRejection,
  IntentStream,
  PresenceTarget,
} from '../types/streams.js';
import { asyncIteratorFrom } from '../utils/asyncIterator.js';
import { toMs } from '../utils/duration.js';

export interface IntentStreamConfig {
  /** Identity used to filter our own active intents out of `others`. */
  participantId: string;
}

export interface AttachableIntentStream extends IntentStream {
  attach(transport: SyncWebSocket): void;
  dispose(): void;
}

interface OwnIntent {
  readonly entityType: string;
  readonly entityId: string;
  readonly path?: string;
  readonly range?: EntityRef['range'];
  readonly field?: string;
  readonly meta?: EntityRef['meta'];
  readonly action: string;
  readonly estimatedMs: number | undefined;
}

export function createIntentStream(
  config: IntentStreamConfig,
  transport: SyncWebSocket | null = null,
): AttachableIntentStream {
  const { participantId } = config;

  // ── State: others' open intents, keyed by intentId ───────────────
  const activeByIntentId = new Map<string, ActiveIntent>();
  let intentsSnapshot: ReadonlyArray<ActiveIntent> = Object.freeze([]);

  // ── State: our own open intents (for re-announce on reconnect) ───
  const ownIntents = new Map<string, OwnIntent>();

  // ── Subscribers ──────────────────────────────────────────────────
  const listeners = new Set<() => void>();
  const rejectionListeners = new Set<(r: IntentRejection) => void>();

  const notifyListeners = () => {
    intentsSnapshot = Object.freeze(Array.from(activeByIntentId.values()));
    for (const l of listeners) {
      try {
        l();
      } catch {
        /* listener errors don't break siblings */
      }
    }
  };

  // ── Wire wiring ──────────────────────────────────────────────────
  let attached: SyncWebSocket | null = null;
  const unsubs: Array<() => void> = [];

  function attach(t: SyncWebSocket): void {
    if (attached) return;
    attached = t;

    // (1) Inbound presence frames carry every participant's full
    //     active-intent set. Prune previous claims by holder, then
    //     re-add from the frame — the frame is authoritative for that
    //     participant's open intents at that moment.
    unsubs.push(
      t.subscribe('presence_update', (event: PresenceUpdateEvent) => {
        if (!event.userId) return;
        if (event.userId === participantId) return;

        let mutated = false;

        if (event.kind === 'leave') {
          for (const [id, intent] of activeByIntentId) {
            if (intent.heldBy === event.userId) {
              activeByIntentId.delete(id);
              mutated = true;
            }
          }
          if (mutated) notifyListeners();
          return;
        }

        for (const [id, intent] of activeByIntentId) {
          if (intent.heldBy === event.userId) {
            activeByIntentId.delete(id);
            mutated = true;
          }
        }
        for (const claim of event.activeIntents ?? []) {
          activeByIntentId.set(claim.intentId, {
            id: claim.intentId,
            heldBy: event.userId,
            participantKind: event.isAgent ? 'agent' : 'human',
            target: {
              type: claim.entityType,
              id: claim.entityId,
              path: claim.path,
              range: claim.range,
              field: claim.field,
              meta: claim.meta,
            },
            reason: claim.action,
            ttlSeconds: Math.max(
              0,
              Math.floor((claim.expiresAt - Date.now()) / 1000),
            ),
            announcedAt: new Date(claim.declaredAt).toISOString(),
            expiresAt: new Date(claim.expiresAt).toISOString(),
          });
          mutated = true;
        }
        if (mutated) notifyListeners();
      }),
    );

    // (2) Server-side rejection frames.
    unsubs.push(
      t.subscribe('intent_rejected', (payload) => {
        const rejection = payload as unknown as IntentRejection;
        if (!rejection.intentId) return;
        // Drop the rejected own-claim so reconnect doesn't re-announce
        // a claim the server already rejected (would just spam both
        // sides with conflicts).
        ownIntents.delete(rejection.intentId);
        for (const l of rejectionListeners) {
          try {
            l(rejection);
          } catch {
            /* isolate */
          }
        }
      }),
    );

    // (3) On reconnect, re-announce every open self-claim — the
    //     server's intent state is in-memory and is lost across
    //     restarts. Without this, peers would see our claims vanish
    //     whenever the connection blipped.
    unsubs.push(
      t.subscribe('connected', () => {
        for (const [intentId, intent] of ownIntents) {
          sendBegin(intentId, intent);
        }
      }),
    );
  }

  if (transport) attach(transport);

  // ── Outbound ────────────────────────────────────────────────────
  function sendBegin(intentId: string, intent: OwnIntent): void {
    if (!attached?.isConnected()) return;
    attached.send({
      type: 'intent_begin',
      payload: {
        intentId,
        entityType: intent.entityType,
        entityId: intent.entityId,
        path: intent.path,
        range: intent.range,
        action: intent.action,
        field: intent.field,
        meta: intent.meta,
        estimatedMs: intent.estimatedMs,
      },
    });
  }

  function sendAbandon(intentId: string): void {
    if (!attached?.isConnected()) return;
    attached.send({ type: 'intent_abandon', payload: { intentId } });
  }

  function mintHandle(args: {
    entityType: string;
    entityId: string;
    path?: string;
    range?: EntityRef['range'];
    field?: string;
    meta?: EntityRef['meta'];
    action: string;
    ttl?: IntentOptions['ttl'];
  }): Claim {
    const intentId = crypto.randomUUID();
    const estimatedMs = args.ttl !== undefined ? toMs(args.ttl) : undefined;
    const intent: OwnIntent = {
      entityType: args.entityType,
      entityId: args.entityId,
      path: args.path,
      range: args.range,
      field: args.field,
      meta: args.meta,
      action: args.action,
      estimatedMs,
    };
    ownIntents.set(intentId, intent);
    sendBegin(intentId, intent);

    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      ownIntents.delete(intentId);
      sendAbandon(intentId);
    };

    return {
      id: intentId,
      revoke,
      [Symbol.asyncDispose]: async () => {
        revoke();
      },
    };
  }

  function resolveTarget(target: PresenceTarget): EntityRef {
    if (Array.isArray(target)) return { type: target[0], id: target[1] };
    return target as EntityRef;
  }

  return {
    claim(target: PresenceTarget, opts?: { reason?: string; ttl?: IntentOptions['ttl'] }): Claim {
      const resolved = resolveTarget(target);
      return mintHandle({
        entityType: resolved.type,
        entityId: resolved.id,
        path: resolved.path,
        range: resolved.range,
        field: resolved.field,
        meta: resolved.meta,
        action: opts?.reason ?? 'editing',
        ttl: opts?.ttl,
      });
    },
    get others() {
      return intentsSnapshot;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRejected: (listener: (rejection: IntentRejection) => void) => {
      rejectionListeners.add(listener);
      return () => {
        rejectionListeners.delete(listener);
      };
    },
    [Symbol.asyncIterator]() {
      return asyncIteratorFrom<ReadonlyArray<ActiveIntent>>(
        (onChange) => {
          listeners.add(onChange);
          return () => {
            listeners.delete(onChange);
          };
        },
        () => intentsSnapshot,
      );
    },
    attach,
    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      listeners.clear();
      rejectionListeners.clear();
      activeByIntentId.clear();
      ownIntents.clear();
      intentsSnapshot = Object.freeze([]);
      attached = null;
    },
  };
}
