/**
 * Creates a {@link ClaimStream} over a live sync connection. A claim is a
 * short-lived, advisory lease a participant takes on an entity (or a field of
 * one) to signal "I'm working on this"; the stream lets you take claims, see
 * everyone else's, and watch the wait queue when a claim is contended.
 *
 * The stream is built directly on the sync WebSocket and shares that one
 * connection. It learns about other participants' claims from the same
 * `presence_update` frames the {@link createPresenceStream} presence stream
 * consumes — the server piggybacks each participant's `activeClaims` on every
 * presence frame — and sends its own claims as `claim_begin` and
 * `claim_abandon` frames.
 *
 * Wire frames:
 *   • Outbound `claim_begin` — announce a claim: `{ claimId, entityType,
 *       entityId, description, field?, estimatedMs? }`.
 *   • Outbound `claim_abandon` — release it: `{ claimId, entityType?,
 *       entityId? }`.
 *   • Inbound, via presence — `event.activeClaims`, each stamped with
 *       `declaredAt` and `expiresAt`.
 *   • Inbound `claim_rejected` — the server refused the claim, with conflict
 *       metadata.
 */

import type {
  SyncWebSocket,
  PresenceUpdateEvent,
} from './SyncWebSocket.js';
import type {
  ClaimOptions,
  ClaimTarget,
  Claim,
  ClaimHeartbeat,
  ClaimHeartbeatOptions,
  ClaimLeaseOptions,
  ClaimRejection,
  ClaimLost,
  ClaimStream,
  PresenceTarget,
} from '../types/streams.js';
import { asyncIteratorFrom } from '../utils/asyncIterator.js';
import { toMs } from '../utils/duration.js';
import {
  claimHeartbeatAckPayloadSchema,
  claimLostSchema,
  descriptionFromMeta,
  participantKindFromWire,
} from '../coordination/schema.js';
import { AbloClaimedError, AbloConnectionError } from '../errors.js';
import { resolveHeartbeatOptions } from '../client/claimHeartbeatLoop.js';
import { getContext } from '../context.js';

/**
 * The wire capability the claim stream actually uses: subscribe to typed
 * inbound frames, check liveness, and send outbound frames. `SyncWebSocket`
 * satisfies it, so production wiring is unchanged — but depending on the port
 * rather than the whole socket class lets a test drive it with a plain object,
 * no cast. `Pick` carries the exact (generic, typed-payload) `subscribe`
 * signature, so every handler stays fully typed.
 */
export type ClaimTransport = Pick<SyncWebSocket, 'subscribe' | 'isConnected' | 'send'>;

/** Readable target for the coordination trace: `documents:abc` / `documents:abc.title`. */
function claimLabel(type: string, id: string, field?: string): string {
  return field ? `${type}:${id}.${field}` : `${type}:${id}`;
}

export interface ClaimStreamConfig {
  /** Identity used to filter our own active claims out of `others`. */
  participantId: string;
}

/**
 * How long a heartbeat waits for its `claim_heartbeat_ack` before giving up
 * as transient (the auto-heartbeat loop's next tick retries). Comfortably
 * above a round trip, comfortably below the ttl/3 beat cadence.
 */
const HEARTBEAT_ACK_TIMEOUT_MS = 10_000;

export interface AttachableClaimStream extends ClaimStream {
  /**
   * Mints a lease directly: sends the `claim_begin` frame and returns a held
   * {@link Claim} that carries no row `data` (the resource layer reads the row
   * and stamps it). This is an internal entry point, not part of the public
   * {@link ClaimStream}; application code takes a claim through
   * `ablo.<model>.claim({ id })`, which is built on this.
   */
  claim(target: PresenceTarget, opts?: ClaimOptions): Claim;
  attach(transport: ClaimTransport): void;
  dispose(): void;
}

interface OwnClaim {
  readonly entityType: string;
  readonly entityId: string;
  readonly path?: string;
  readonly range?: ClaimTarget['range'];
  readonly field?: string;
  readonly meta?: ClaimTarget['meta'];
  /** Peer-visible description of the work, shown to other participants. */
  readonly description: string;
  readonly estimatedMs: number | undefined;
  /** When set, wait in the server's fair first-come-first-served queue if the
   *  entity is already claimed, instead of being rejected. */
  readonly queue?: boolean;
}

export function createClaimStream(
  config: ClaimStreamConfig,
  transport: ClaimTransport | null = null,
): AttachableClaimStream {
  const { participantId } = config;

  // ── State: others' open claims, keyed by claimId ───────────────
  const activeByClaimId = new Map<string, Claim>();
  let claimsSnapshot: readonly Claim[] = Object.freeze([]);

  // ── State: our own open claims (for re-announce on reconnect) ───
  const ownClaims = new Map<string, OwnClaim>();

  // ── State: per-entity wait queues, from `claim_queue` frames ────
  // Keyed `type:id`; the value is the FIFO line of queued claims. Powers
  // the reactive `queue(target)` read — who's waiting and what they intend.
  const queueByEntity = new Map<string, readonly Claim[]>();
  const entityKey = (type: string, id: string): string => `${type}:${id}`;
  const EMPTY_QUEUE: readonly Claim[] = Object.freeze([]);
  // Last queue position we logged per own-claim, so advancing in line is traced
  // once per change (not re-logged on every server re-fan of the same line).
  const lastLoggedQueuePos = new Map<string, number>();

  // ── Subscribers ──────────────────────────────────────────────────
  const listeners = new Set<() => void>();
  const rejectionListeners = new Set<(r: ClaimRejection) => void>();
  const lostListeners = new Set<(l: ClaimLost) => void>();

  // ── State: in-flight heartbeats awaiting their ack, keyed by claimId ──
  const pendingHeartbeats = new Map<
    string,
    {
      resolve: (value: ClaimHeartbeat) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const settleHeartbeat = (
    claimId: string,
    settle: (pending: {
      resolve: (value: ClaimHeartbeat) => void;
      reject: (error: Error) => void;
    }) => void,
  ): void => {
    const pending = pendingHeartbeats.get(claimId);
    if (!pending) return;
    pendingHeartbeats.delete(claimId);
    clearTimeout(pending.timer);
    settle(pending);
  };

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
  let attached: ClaimTransport | null = null;
  const unsubs: (() => void)[] = [];

  function attach(t: ClaimTransport): void {
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
          // Resolve the always-present public field, tolerating a frame that
          // carries the value in `meta` rather than as an explicit description.
          const description =
            claim.description ??
            descriptionFromMeta(claim.meta) ??
            'editing';
          activeByClaimId.set(claim.claimId, {
            object: 'claim',
            id: claim.claimId,
            status: 'active',
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
            description,
            ttlSeconds: Math.max(
              0,
              Math.floor((claim.expiresAt - Date.now()) / 1000),
            ),
            createdAt: claim.declaredAt,
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
        if (ownClaims.has(rejection.claimId)) {
          const tgt = rejection.target
            ? claimLabel(rejection.target.entityType, rejection.target.entityId, rejection.target.field)
            : rejection.claimId;
          getContext().logger.info(
            `claim: rejected ${tgt}${rejection.heldBy ? ` — held by ${rejection.heldBy}` : ''}`,
            { claimId: rejection.claimId, reason: rejection.reason },
          );
        }
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

    // (2a) Server-side loss frames — you held the claim, then lost it
    //      (preempted or expired). Distinct from a rejection, which is a claim
    //      the server refused.
    unsubs.push(
      t.subscribe('claim_lost', (payload) => {
        const parsed = claimLostSchema.safeParse(payload);
        if (!parsed.success) return;
        const lost = parsed.data;
        if (ownClaims.has(lost.claimId)) {
          const c = ownClaims.get(lost.claimId);
          getContext().logger.info(
            `claim: lost ${c ? claimLabel(c.entityType, c.entityId, c.field) : lost.claimId} (preempted or expired)`,
            { claimId: lost.claimId },
          );
        }
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
        // If we are in this line, trace our position (the "agent queued behind a
        // claim" moment) — once per position change, so advancing is visible.
        const ourIndex = line.findIndex((c) => ownClaims.has(c.id));
        const ourClaim = ourIndex >= 0 ? line[ourIndex] : undefined;
        if (ourClaim) {
          const ourId = ourClaim.id;
          if (lastLoggedQueuePos.get(ourId) !== ourIndex) {
            lastLoggedQueuePos.set(ourId, ourIndex);
            getContext().logger.info(
              `claim: queued for ${claimLabel(p.target.type, p.target.id)} — position ${ourIndex + 1} of ${line.length}, waiting`,
              { claimId: ourId },
            );
          }
        }
        notifyListeners();
      }),
    );

    // (2c) Heartbeat replies — correlate back to the awaiting beat by
    //      claimId. `held` resolves with the extended expiry; `queued` and
    //      `lost` reject with a typed claimed error, because a heartbeat on
    //      a handle we thought we held coming back as anything but `held`
    //      means the lease is no longer ours.
    unsubs.push(
      t.subscribe('claim_heartbeat_ack', (payload) => {
        const parsed = claimHeartbeatAckPayloadSchema.safeParse(payload);
        if (!parsed.success) return;
        const ack = parsed.data;
        settleHeartbeat(ack.claimId, ({ resolve, reject }) => {
          if (ack.status === 'held' && ack.expiresAt !== undefined) {
            resolve({
              expiresAt: ack.expiresAt,
              ...(ack.queueDepth !== undefined
                ? { queueDepth: ack.queueDepth }
                : {}),
            });
            return;
          }
          const c = ownClaims.get(ack.claimId);
          reject(
            new AbloClaimedError(
              `The lease behind ${c ? claimLabel(c.entityType, c.entityId, c.field) : `claim ${ack.claimId}`} is no longer held — it expired or was granted onward while this participant was working. Re-acquire the claim and retry; a write attempted under the old lease is rejected by its \`readAt\` guard.`,
              { code: 'claim_lost' },
            ),
          );
        });
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
        description: claim.description,
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

  /**
   * Send one heartbeat and await its ack. Rejects with
   * {@link AbloConnectionError} (transient — the auto-heartbeat loop retries
   * on its next tick) when the socket is down or the ack times out, and with
   * {@link AbloClaimedError} (definitive) when the server answers that the
   * lease is no longer ours.
   */
  function sendHeartbeat(
    claimId: string,
    claim: OwnClaim,
    options: ClaimHeartbeatOptions,
  ): Promise<ClaimHeartbeat> {
    if (!attached?.isConnected()) {
      return Promise.reject(
        new AbloConnectionError(
          `The heartbeat for ${claimLabel(claim.entityType, claim.entityId, claim.field)} was skipped because the connection is down. The keepalive renews held leases automatically on reconnect; the next beat retries.`,
        ),
      );
    }
    return new Promise<ClaimHeartbeat>((resolve, reject) => {
      settleHeartbeat(claimId, ({ reject: rejectPrior }) => {
        rejectPrior(
          new AbloConnectionError(
            'A newer heartbeat for this claim superseded the one still awaiting its reply.',
          ),
        );
      });
      const timer = setTimeout(() => {
        settleHeartbeat(claimId, ({ reject: rejectTimeout }) => {
          rejectTimeout(
            new AbloConnectionError(
              `No reply to the heartbeat for ${claimLabel(claim.entityType, claim.entityId, claim.field)} arrived within ${HEARTBEAT_ACK_TIMEOUT_MS / 1000}s. The next beat retries.`,
            ),
          );
        });
      }, HEARTBEAT_ACK_TIMEOUT_MS);
      pendingHeartbeats.set(claimId, { resolve, reject, timer });
      attached?.send({
        type: 'claim_heartbeat',
        payload: {
          claimId,
          entityType: claim.entityType,
          entityId: claim.entityId,
          ...(options.ttl !== undefined ? { ttlMs: toMs(options.ttl) } : {}),
          ...(options.details !== undefined ? { details: options.details } : {}),
        },
      });
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

  function mintHandle(args: {
    entityType: string;
    entityId: string;
    path?: string;
    range?: ClaimTarget['range'];
    field?: string;
    meta?: ClaimTarget['meta'];
    description: string;
    ttl?: ClaimLeaseOptions['ttl'];
    queue?: boolean;
  }): Claim {
    const claimId = crypto.randomUUID();
    const estimatedMs = args.ttl !== undefined ? toMs(args.ttl) : undefined;
    const claim: OwnClaim = {
      entityType: args.entityType,
      entityId: args.entityId,
      path: args.path,
      range: args.range,
      field: args.field,
      meta: args.meta,
      description: args.description,
      estimatedMs,
      queue: args.queue,
    };
    ownClaims.set(claimId, claim);
    sendBegin(claimId, claim);
    // Coordination trace (info): the creator can see their human/agent claims.
    getContext().logger.info(
      `claim: requesting ${claimLabel(claim.entityType, claim.entityId, claim.field)} for "${claim.description}"` +
        (claim.queue ? ' (will queue if contended)' : ''),
      { claimId },
    );

    let revoked = false;
    const revoke = () => {
      if (revoked) return;
      revoked = true;
      ownClaims.delete(claimId);
      sendAbandon(claimId, claim);
      getContext().logger.info(
        `claim: released ${claimLabel(claim.entityType, claim.entityId, claim.field)}`,
        { claimId },
      );
    };

    return {
      object: 'claim',
      id: claimId,
      status: 'active',
      description: args.description,
      target: {
        type: args.entityType,
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
      heartbeat: (options?: ClaimLeaseOptions['ttl'] | ClaimHeartbeatOptions) =>
        sendHeartbeat(claimId, claim, resolveHeartbeatOptions(options)),
      [Symbol.asyncDispose]: async () => {
        revoke();
      },
    };
  }

  function resolveTarget(target: PresenceTarget): ClaimTarget {
    if (Array.isArray(target)) return { type: target[0], id: target[1] };
    return target as ClaimTarget;
  }

  return {
    claim(
      target: PresenceTarget,
      opts?: ClaimOptions,
    ): Claim {
      const resolved = resolveTarget(target);
      return mintHandle({
        entityType: resolved.type,
        entityId: resolved.id,
        path: resolved.path,
        range: resolved.range,
        field: resolved.field,
        meta: resolved.meta,
        description: opts?.description ?? 'editing',
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
      return asyncIteratorFrom<readonly Claim[]>(
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
      for (const claimId of [...pendingHeartbeats.keys()]) {
        settleHeartbeat(claimId, ({ reject }) => {
          reject(
            new AbloConnectionError(
              'The claim stream was disposed while this heartbeat was awaiting its reply.',
            ),
          );
        });
      }
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
