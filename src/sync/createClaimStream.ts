/**
 * Transport-driven ClaimStream factory.
 *
 * Mirrors `createPresenceStream` — built directly on `SyncWebSocket`,
 * no SyncAgent wrapper. Claims derive their `others` view from the
 * same `presence_update` frames the presence stream consumes (the
 * Hub piggybacks `activeClaims` on every presence frame). Outbound
 * announce/revoke ride the same socket via `claim_begin` /
 * `claim_abandon` frames.
 *
 * Wire contract (apps/sync-server/src/hub/types.ts):
 *   • Outbound: `{ type: 'claim_begin', payload: { claimId,
 *       entityType, entityId, action, field?, estimatedMs? } }`
 *   • Outbound: `{ type: 'claim_abandon', payload: { claimId,
 *       entityType?, entityId? } }`
 *   • Inbound (via presence): `event.activeClaims: Claim[]`
 *     stamped with `declaredAt`, `expiresAt`.
 *   • Inbound: `claim_rejected` event with conflict metadata.
 *
 * After the dual-engine collapse (step #36), this is the only
 * ClaimStream factory in the SDK; the older compatibility path
 * deletes.
 */

import type {
  SyncWebSocket,
  PresenceUpdateEvent,
} from './SyncWebSocket.js';
import type {
  ActiveClaim,
  ClaimOptions,
  EntityRef,
  ClaimHandle,
  Claim,
  ClaimLeaseOptions,
  ClaimRejection,
  ClaimLost,
  ClaimStream,
  PresenceTarget,
} from '../types/streams.js';
import { asyncIteratorFrom } from '../utils/asyncIterator.js';
import { toMs } from '../utils/duration.js';
import {
  descriptionFromMeta,
  participantKindFromWire,
} from '../coordination/schema.js';

export interface ClaimStreamConfig {
  /** Identity used to filter our own active claims out of `others`. */
  participantId: string;
}

export interface AttachableClaimStream extends ClaimStream {
  attach(transport: SyncWebSocket): void;
  dispose(): void;
}

interface OwnClaim {
  readonly entityType: string;
  readonly entityId: string;
  readonly path?: string;
  readonly range?: EntityRef['range'];
  readonly field?: string;
  readonly meta?: EntityRef['meta'];
  readonly action: string;
  readonly estimatedMs: number | undefined;
  /** Opt into the server's fair FIFO queue on contention (vs. reject). */
  readonly queue?: boolean;
}

export function createClaimStream(
  config: ClaimStreamConfig,
  transport: SyncWebSocket | null = null,
): AttachableClaimStream {
  const { participantId } = config;

  // ── State: others' open claims, keyed by claimId ───────────────
  const activeByClaimId = new Map<string, ActiveClaim>();
  let claimsSnapshot: ReadonlyArray<ActiveClaim> = Object.freeze([]);

  // ── State: our own open claims (for re-announce on reconnect) ───
  const ownClaims = new Map<string, OwnClaim>();

  // ── State: per-entity wait queues, from `claim_queue` frames ────
  // Keyed `type:id`; the value is the FIFO line of queued claims. Powers
  // the reactive `queue(target)` read — who's waiting and what they intend.
  const queueByEntity = new Map<string, ReadonlyArray<Claim>>();
  const entityKey = (type: string, id: string): string => `${type}:${id}`;
  const EMPTY_QUEUE: readonly Claim[] = Object.freeze([]);

  // ── Subscribers ──────────────────────────────────────────────────
  const listeners = new Set<() => void>();
  const rejectionListeners = new Set<(r: ClaimRejection) => void>();
  const lostListeners = new Set<(l: ClaimLost) => void>();

  const notifyListeners = () => {
    claimsSnapshot = Object.freeze(Array.from(activeByClaimId.values()));
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
    //     active-claim set. Prune previous claims by holder, then
    //     re-add from the frame — the frame is authoritative for that
    //     participant's open claims at that moment.
    unsubs.push(
      t.subscribe('presence_update', (event: PresenceUpdateEvent) => {
        if (!event.userId) return;
        if (event.userId === participantId) return;

        let mutated = false;

        if (event.kind === 'leave') {
          for (const [id, claim] of activeByClaimId) {
            if (claim.heldBy === event.userId) {
              activeByClaimId.delete(id);
              mutated = true;
            }
          }
          if (mutated) notifyListeners();
          return;
        }

        for (const [id, claim] of activeByClaimId) {
          if (claim.heldBy === event.userId) {
            activeByClaimId.delete(id);
            mutated = true;
          }
        }
        for (const claim of event.activeClaims ?? []) {
          // Terminal-status entries (committed / expired / canceled) are
          // one-shot "this claim ended" signals. The holder sweep above
          // already removed the prior active entry; skipping the re-add
          // drops it from `others`, which is what resolves a contender's
          // `settled()`. Absent status means active (wire back-compat).
          if (claim.status && claim.status !== 'active') continue;
          const description = descriptionFromMeta(claim.meta);
          activeByClaimId.set(claim.claimId, {
            id: claim.claimId,
            heldBy: event.userId,
            participantKind: participantKindFromWire(
              event.participantKind,
              event.isAgent,
            ),
            target: {
              type: claim.entityType,
              id: claim.entityId,
              path: claim.path,
              range: claim.range,
              field: claim.field,
              meta: claim.meta,
            },
            reason: claim.action,
            ...(description ? { description } : {}),
            ttlSeconds: Math.max(
              0,
              Math.floor((claim.expiresAt - Date.now()) / 1000),
            ),
            announcedAt: claim.declaredAt,
            expiresAt: claim.expiresAt,
          });
          mutated = true;
        }
        if (mutated) notifyListeners();
      }),
    );

    // (2) Server-side rejection frames.
    unsubs.push(
      t.subscribe('claim_rejected', (rejection) => {
        if (!rejection.claimId) return;
        // Drop the rejected own-claim so reconnect doesn't re-announce
        // a claim the server already rejected (would just spam both
        // sides with conflicts).
        ownClaims.delete(rejection.claimId);
        for (const l of rejectionListeners) {
          try {
            l(rejection);
          } catch {
            /* isolate */
          }
        }
      }),
    );

    // (2a) Server-side LOSS frames — you held it, then lost it (preempted /
    //      expired). Distinct from a rejection (a claim the server refused).
    unsubs.push(
      t.subscribe('claim_lost', (payload) => {
        const lost = payload as unknown as ClaimLost;
        if (!lost.claimId) return;
        // Drop the lost own-claim so reconnect doesn't re-announce a lease we
        // no longer hold.
        ownClaims.delete(lost.claimId);
        for (const l of lostListeners) {
          try {
            l(lost);
          } catch {
            /* isolate */
          }
        }
      }),
    );

    // (2b) Per-entity wait-queue snapshots. The server fans the full line
    //      out on every queue mutation; we replace our cached line for that
    //      entity and notify so `queue(target)` reads reactively.
    unsubs.push(
      t.subscribe('claim_queue', (payload) => {
        const p = payload as {
          target?: { type?: string; id?: string };
          queue?: Claim[];
        };
        if (!p.target?.type || !p.target.id) return;
        const key = entityKey(p.target.type, p.target.id);
        const line = Array.isArray(p.queue) ? p.queue : [];
        if (line.length === 0) queueByEntity.delete(key);
        else queueByEntity.set(key, Object.freeze([...line]));
        notifyListeners();
      }),
    );

    // (3) On reconnect, re-announce every open self-claim — the
    //     server's claim state is in-memory and is lost across
    //     restarts. Without this, peers would see our claims vanish
    //     whenever the connection blipped.
    unsubs.push(
      t.subscribe('connected', () => {
        for (const [claimId, claim] of ownClaims) {
          sendBegin(claimId, claim);
        }
      }),
    );
  }

  if (transport) attach(transport);

  // ── Outbound ────────────────────────────────────────────────────
  function sendBegin(claimId: string, claim: OwnClaim): void {
    if (!attached?.isConnected()) return;
    attached.send({
      type: 'claim_begin',
      payload: {
        claimId,
        entityType: claim.entityType,
        entityId: claim.entityId,
        path: claim.path,
        range: claim.range,
        action: claim.action,
        field: claim.field,
        meta: claim.meta,
        estimatedMs: claim.estimatedMs,
        queue: claim.queue,
      },
    });
  }

  function sendReorder(
    entityType: string,
    entityId: string,
    order: readonly Claim[],
  ): void {
    if (!attached?.isConnected()) return;
    attached.send({
      type: 'claim_reorder',
      payload: {
        entityType,
        entityId,
        // The wire shape identifies a waiter by heldBy + claimId; map the
        // ergonomic `Claim[]` (what `queueFor` returns) down to that.
        order: order.map((i) => ({ heldBy: i.heldBy, claimId: i.id })),
      },
    });
  }

  function sendAbandon(claimId: string, claim?: OwnClaim): void {
    if (!attached?.isConnected()) return;
    // Carry the target so the server can dequeue us if we were only *waiting*
    // (a queued claim isn't in the holder set it would otherwise scan). Held
    // claims are found by claimId regardless; the target is harmless there.
    attached.send({
      type: 'claim_abandon',
      payload: {
        claimId,
        entityType: claim?.entityType,
        entityId: claim?.entityId,
      },
    });
  }

  function withDescription(
    meta: EntityRef['meta'],
    description: string | undefined,
  ): EntityRef['meta'] {
    if (!description) return meta;
    return { ...(meta ?? {}), description };
  }

  function mintHandle(args: {
    entityType: string;
    entityId: string;
    path?: string;
    range?: EntityRef['range'];
    field?: string;
    meta?: EntityRef['meta'];
    action: string;
    ttl?: ClaimLeaseOptions['ttl'];
    queue?: boolean;
  }): ClaimHandle {
    const claimId = crypto.randomUUID();
    const estimatedMs = args.ttl !== undefined ? toMs(args.ttl) : undefined;
    const claim: OwnClaim = {
      entityType: args.entityType,
      entityId: args.entityId,
      path: args.path,
      range: args.range,
      field: args.field,
      meta: args.meta,
      action: args.action,
      estimatedMs,
      queue: args.queue,
    };
    ownClaims.set(claimId, claim);
    sendBegin(claimId, claim);

    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      ownClaims.delete(claimId);
      sendAbandon(claimId, claim);
    };

    return {
      object: 'claim',
      claimId,
      action: args.action,
      target: {
        model: args.entityType,
        id: args.entityId,
        path: args.path,
        range: args.range,
        field: args.field,
        meta: args.meta,
      },
      release: async () => {
        revoke();
      },
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
    claim(
      target: PresenceTarget,
      opts?: ClaimOptions,
    ): ClaimHandle {
      const resolved = resolveTarget(target);
      return mintHandle({
        entityType: resolved.type,
        entityId: resolved.id,
        path: resolved.path,
        range: resolved.range,
        field: resolved.field,
        meta: withDescription(resolved.meta, opts?.description),
        action: opts?.reason ?? 'editing',
        ttl: opts?.ttl,
        queue: opts?.queue,
      });
    },
    get others() {
      return claimsSnapshot;
    },
    queueFor(target: PresenceTarget): readonly Claim[] {
      const ref = resolveTarget(target);
      return queueByEntity.get(entityKey(ref.type, ref.id)) ?? EMPTY_QUEUE;
    },
    reorder(target: PresenceTarget, order: readonly Claim[]): void {
      const ref = resolveTarget(target);
      sendReorder(ref.type, ref.id, order);
    },
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRejected: (listener: (rejection: ClaimRejection) => void) => {
      rejectionListeners.add(listener);
      return () => {
        rejectionListeners.delete(listener);
      };
    },
    onLost: (listener: (lost: ClaimLost) => void) => {
      lostListeners.add(listener);
      return () => {
        lostListeners.delete(listener);
      };
    },
    [Symbol.asyncIterator]() {
      return asyncIteratorFrom<ReadonlyArray<ActiveClaim>>(
        (onChange) => {
          listeners.add(onChange);
          return () => {
            listeners.delete(onChange);
          };
        },
        () => claimsSnapshot,
      );
    },
    attach,
    dispose(): void {
      for (const off of unsubs) off();
      unsubs.length = 0;
      listeners.clear();
      rejectionListeners.clear();
      lostListeners.clear();
      activeByClaimId.clear();
      ownClaims.clear();
      queueByEntity.clear();
      claimsSnapshot = Object.freeze([]);
      attached = null;
    },
  };
}
