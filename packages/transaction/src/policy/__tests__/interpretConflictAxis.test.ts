/**
 * `interpretConflictAxis` — the generic interpreter for the declared `conflict`
 * schema axis (Axis 3). Pure + synchronous; maps a per-committer-kind
 * `OnStaleMode` declaration onto a `ConflictDecision`.
 *
 * The full matrix: committer kind present/absent × {reject, overwrite, notify}
 * × {stale_context, claim_held}.
 */

import {
  interpretConflictAxis,
  defaultPolicy,
  type ConflictAxis,
  type Conflict,
} from '../types.js';
import type { OnStaleMode } from '@abloatai/transaction/coordination/schema';

type Kind = 'user' | 'agent' | 'system';

const claimHeld = (kind: Kind): Conflict => ({
  kind: 'claim_held',
  committer: { kind, id: 'committer' },
  organizationId: 'o1',
  heldBy: { kind: 'user', id: 'holder' },
  claimId: 'c1',
  entityType: 'Widget',
  entityId: 'w1',
  expiresAt: 0,
  committerOperations: [],
});

const stale = (kind: Kind, requestedMode?: OnStaleMode): Conflict => ({
  kind: 'stale_context',
  committer: { kind, id: 'committer' },
  organizationId: 'o1',
  operation: { model: 'Widget', id: 'w1', type: 'UPDATE' },
  readAt: 1,
  observedSyncId: 2,
  requestedMode,
});

describe('interpretConflictAxis', () => {
  it("'overwrite' → allow on both conflict kinds (the committer wins / is never blocked)", () => {
    const axis: ConflictAxis = { user: 'overwrite' };
    expect(interpretConflictAxis(axis, claimHeld('user'))).toEqual({
      action: 'allow',
      note: 'conflict:overwrite',
    });
    expect(interpretConflictAxis(axis, stale('user'))).toEqual({
      action: 'allow',
      note: 'conflict:overwrite',
    });
  });

  it("'reject' → reject with a kind-specific reason (the committer yields)", () => {
    const axis: ConflictAxis = { agent: 'reject' };
    expect(interpretConflictAxis(axis, claimHeld('agent'))).toMatchObject({
      action: 'reject',
      reason: 'claim_conflict',
    });
    expect(interpretConflictAxis(axis, stale('agent'))).toMatchObject({
      action: 'reject',
      reason: 'stale_context',
    });
  });

  it("'notify' → notify on a stale write; degrades to reject on a held claim", () => {
    const axis: ConflictAxis = { agent: 'notify' };
    expect(interpretConflictAxis(axis, stale('agent', 'notify'))).toMatchObject({
      action: 'notify',
      reason: 'stale_notify_hold',
    });
    // notify has no held op to reconcile against a claim → conservative reject,
    // never a silent allow of a claimed-row write.
    expect(interpretConflictAxis(axis, claimHeld('agent'))).toMatchObject({
      action: 'reject',
      reason: 'claim_conflict',
    });
  });

  it('an unlisted committer kind falls through to the engine default (parity with defaultPolicy)', () => {
    const axis: ConflictAxis = { user: 'overwrite' }; // agent + system unlisted
    expect(interpretConflictAxis(axis, claimHeld('agent'))).toEqual(defaultPolicy(claimHeld('agent')));
    expect(interpretConflictAxis(axis, stale('agent', 'notify'))).toEqual(
      defaultPolicy(stale('agent', 'notify')),
    );
    expect(interpretConflictAxis(axis, stale('system'))).toEqual(defaultPolicy(stale('system')));
  });

  it('the slides stance { user: overwrite, agent: reject }: human wins, agent yields', () => {
    const axis: ConflictAxis = { user: 'overwrite', agent: 'reject' };
    // human editing → an agent write to the same claimed row yields
    expect(interpretConflictAxis(axis, claimHeld('agent'))).toMatchObject({ action: 'reject' });
    // human commit over any conflict → allowed (never blocked, LWW)
    expect(interpretConflictAxis(axis, claimHeld('user'))).toMatchObject({ action: 'allow' });
    expect(interpretConflictAxis(axis, stale('user'))).toMatchObject({ action: 'allow' });
  });
});
