/**
 * onLost — a holder learning it lost an claim it HELD (preempted / expired),
 * distinct from onRejected (a claim the server refused). Verifies the
 * `claim_lost` frame is surfaced with its `reason` so a holder can re-plan
 * (preempted) vs re-claim (expired).
 */

import { EventEmitter } from 'events';
import { describe, it, expect } from '@jest/globals';
import { createClaimStream, type ClaimTransport } from '../createClaimStream.js';
import type { ClaimLost } from '@abloatai/transaction/types/streams';
import {
  dispatchWsFrame,
  type WsSession,
} from '@abloatai/transaction/transport/websocket';
import { noopLogger } from '@abloatai/transaction/logger';
import { noopSocketObservability } from '@abloatai/transaction/observability';
import { claimLifetimeOf } from '@abloatai/transaction/claims/lifetime';

/**
 * A `ClaimTransport` backed by a real EventEmitter, plus a test-only `emit` to
 * drive inbound frames. Node's `on`/`emit` accept any listener, so the port's
 * typed `subscribe` handlers pass straight through — no cast needed, and the
 * object satisfies `ClaimTransport` directly.
 */
function fakeWs(): ClaimTransport & {
  emit(event: string, payload: Record<string, unknown>): void;
  sent: unknown[];
} {
  const bus = new EventEmitter();
  const sent: unknown[] = [];
  return {
    subscribe(event, handler) {
      bus.on(event, handler);
      return () => bus.off(event, handler);
    },
    isConnected: () => true,
    send: (frame) => {
      sent.push(frame);
    },
    sent,
    emit(event, payload) {
      bus.emit(event, payload);
    },
  };
}

/**
 * The minimal `WsSession` the frame dispatcher needs, with `emit` routed to a
 * spy. Only the members a `claim_lost` frame touches are real; the rest exist
 * because the interface asks for them.
 */
function frameSession(onEmit: (event: string, payload: unknown) => void): WsSession {
  return {
    emit: (event, ...args) => {
      onEmit(event, args[0]);
      return true;
    },
    logger: noopLogger,
    observability: noopSocketObservability,
    pendingMutations: new Map(),
    pendingClaims: new Map(),
    shiftPendingSubscription: () => undefined,
    options: { syncGroups: [] },
    collaborationEventTypes: new Set<string>(),
    handleDelta: () => undefined,
    handleSyncResponse: () => undefined,
    handleBootstrapResponse: () => undefined,
    handlePresenceUpdate: () => undefined,
  };
}

describe('createClaimStream.onLost', () => {
  it('ends the exact granted handle when the server reports it lost', () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws);
    const handle = stream.claim(
      { type: 'item', id: 't1' },
      { description: 'editing' },
      'i-exact',
    );
    const lifetime = claimLifetimeOf(handle);

    ws.emit('claim_lost', {
      claimId: 'i-exact',
      reason: 'preempted',
      target: { entityType: 'item', entityId: 't1' },
    });

    expect(lifetime?.ended).toBe(true);
    expect(lifetime?.reason).toMatchObject({ code: 'claim_lost' });
  });

  it('ends grants on disconnect and never re-announces them on reconnect', () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws);
    const handle = stream.claim(
      { type: 'item', id: 't1' },
      { description: 'editing' },
      'i-one-grant',
    );
    const lifetime = claimLifetimeOf(handle);
    expect(ws.sent).toHaveLength(1);

    ws.emit('disconnected', {});
    ws.emit('connected', {});

    expect(lifetime?.ended).toBe(true);
    expect(lifetime?.reason).toMatchObject({ name: 'AbloConnectionError' });
    expect(ws.sent).toHaveLength(1);
  });

  it('delivers claim_lost with reason="preempted" to onLost listeners', () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws);

    const seen: ClaimLost[] = [];
    stream.onLost((l) => seen.push(l));

    ws.emit('claim_lost', {
      claimId: 'i1',
      reason: 'preempted',
      target: { entityType: 'item', entityId: 't1' },
    });

    expect(seen).toHaveLength(1);
    const lost = seen[0];
    if (!lost) throw new Error('expected a delivered claim_lost event');
    expect(lost.reason).toBe('preempted');
    expect(lost.claimId).toBe('i1');
    expect(lost.target.entityId).toBe('t1');
  });

  it('also surfaces reason="expired"', () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws);

    const seen: ClaimLost[] = [];
    stream.onLost((l) => seen.push(l));
    ws.emit('claim_lost', {
      claimId: 'i2',
      reason: 'expired',
      target: { entityType: 'item', entityId: 't2' },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.reason).toBe('expired');
  });

  // The next two guard the same promise as before — a malformed `claim_lost`
  // never reaches an `onLost` listener — but they drive it through
  // `dispatchWsFrame`, which is where the check now lives. Emitting straight
  // onto the transport would skip validation and prove nothing: the stream is
  // downstream of the frame dispatch and trusts what it is handed.
  it('rejects a malformed frame with no claimId, and delivers nothing', () => {
    const seen: ClaimLost[] = [];
    const session = frameSession((event, payload) => {
      if (event === 'claim_lost') seen.push(payload as ClaimLost);
    });

    expect(() => {
      dispatchWsFrame(session, {
        type: 'claim_lost',
        payload: { reason: 'expired' },
      });
    }).toThrow(/does not match the protocol/);
    expect(seen).toHaveLength(0);
  });

  it('rejects an unknown reason or an incomplete target, and delivers nothing', () => {
    const seen: ClaimLost[] = [];
    const session = frameSession((event, payload) => {
      if (event === 'claim_lost') seen.push(payload as ClaimLost);
    });

    // `reason` is a closed set: expired or preempted, nothing else.
    expect(() => {
      dispatchWsFrame(session, {
        type: 'claim_lost',
        payload: {
          claimId: 'i-invalid-reason',
          reason: 'disappeared',
          target: { entityType: 'item', entityId: 't1' },
        },
      });
    }).toThrow(/does not match the protocol/);

    // A target names both halves or it does not name a row.
    expect(() => {
      dispatchWsFrame(session, {
        type: 'claim_lost',
        payload: {
          claimId: 'i-incomplete-target',
          reason: 'expired',
          target: { entityType: 'item' },
        },
      });
    }).toThrow(/does not match the protocol/);

    expect(seen).toHaveLength(0);
  });

  it('unsubscribe stops delivery', () => {
    const ws = fakeWs();
    const stream = createClaimStream({ participantId: 'me' });
    stream.attach(ws);

    const seen: ClaimLost[] = [];
    const off = stream.onLost((l) => seen.push(l));
    off();
    ws.emit('claim_lost', {
      claimId: 'i3',
      reason: 'preempted',
      target: { entityType: 'item', entityId: 't3' },
    });

    expect(seen).toHaveLength(0);
  });
});
