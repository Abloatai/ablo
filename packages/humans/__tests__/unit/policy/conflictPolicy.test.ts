/**
 * Conflict policy contract — type shape, default behavior, composition.
 *
 * Server-side enforcement (the policy actually firing inside
 * `executeCommit:Step 0` and `Hub.claim_begin`) is covered by the
 * sync-server integration suite. This file pins the public contract:
 * what customers see when they implement `ConflictPolicy`.
 */

import { describe, it, expect } from '@jest/globals';
import {
  defaultPolicy,
  capabilityPreemptPolicy,
  type Conflict,
  type ConflictDecision,
  type ConflictPolicy,
} from '@abloatai/transaction/policy/types';

const staleConflict: Conflict = {
  kind: 'stale_context',
  committer: { kind: 'agent', id: 'agent_x' },
  organizationId: 'org_acme',
  delegationChainRootUserId: 'user_abc',
  operation: {
    model: 'Slide',
    id: 's1',
    type: 'UPDATE',
    input: { title: 'new' },
  },
  readAt: 4242,
  observedSyncId: 4250,
};

const claimConflict: Conflict = {
  kind: 'claim_held',
  committer: { kind: 'agent', id: 'agent_x' },
  organizationId: 'org_acme',
  delegationChainRootUserId: 'user_abc',
  heldBy: { kind: 'agent', id: 'agent_y' },
  claimId: 'claim_999',
  entityType: 'Slide',
  entityId: 's1',
  expiresAt: Date.now() + 60_000,
  committerOperations: [],
};

describe('defaultPolicy', () => {
  it('rejects stale_context with reason="stale_context"', async () => {
    const decision = await defaultPolicy(staleConflict);
    expect(decision).toEqual({
      action: 'reject',
      reason: 'stale_context',
    });
  });

  it('rejects claim_held with reason="claim_conflict"', async () => {
    const decision = await defaultPolicy(claimConflict);
    expect(decision).toEqual({
      action: 'reject',
      reason: 'claim_conflict',
    });
  });
});

describe('ConflictPolicy — composition', () => {
  it('a custom policy can fall through to the default', async () => {
    const linterCosmetic: ConflictPolicy = (conflict) => {
      if (
        conflict.committer.kind === 'agent' &&
        conflict.committer.id.startsWith('linter:')
      ) {
        return { action: 'allow', note: 'cosmetic-only writer' };
      }
      return defaultPolicy(conflict);
    };

    const linterDecision = await linterCosmetic({
      ...staleConflict,
      committer: { kind: 'agent', id: 'linter:prettier' },
    });
    expect(linterDecision).toMatchObject({
      action: 'allow',
      note: 'cosmetic-only writer',
    });

    const otherDecision = await linterCosmetic(staleConflict);
    expect(otherDecision).toMatchObject({ action: 'reject' });
  });

  it('discriminates on kind via TypeScript narrowing — flat access, no nesting', async () => {
    const fieldAware: ConflictPolicy = (conflict) => {
      if (conflict.kind === 'stale_context') {
        // Narrowed: TS sees readAt + observedSyncId at the top level.
        return {
          action: 'reject',
          reason: `${conflict.observedSyncId - conflict.readAt}-deltas-behind`,
        };
      }
      // Narrowed: TS sees heldBy + claimId at the top level.
      return {
        action: 'reject',
        reason: `held-by-${conflict.heldBy.id}`,
      };
    };

    expect(await fieldAware(staleConflict)).toEqual({
      action: 'reject',
      reason: '8-deltas-behind',
    });
    expect(await fieldAware(claimConflict)).toEqual({
      action: 'reject',
      reason: 'held-by-agent_y',
    });
  });

  it('async policy is awaited correctly', async () => {
    const slowPolicy: ConflictPolicy = async (_conflict) => {
      await new Promise((r) => setTimeout(r, 5));
      return { action: 'allow', note: 'after-delay' };
    };

    expect(await slowPolicy(staleConflict)).toEqual({
      action: 'allow',
      note: 'after-delay',
    });
  });
});

describe('capabilityPreemptPolicy', () => {
  it('preempts a claim_held conflict when the committer holds claim.preempt', async () => {
    const decision = await capabilityPreemptPolicy({
      ...claimConflict,
      committerOperations: ['task.update', 'claim.preempt'],
    });
    expect(decision).toEqual({ action: 'preempt', reason: 'capability:claim.preempt' });
  });

  it('falls through to reject when the committer lacks claim.preempt', async () => {
    const decision = await capabilityPreemptPolicy({
      ...claimConflict,
      committerOperations: ['task.update'],
    });
    expect(decision).toEqual({ action: 'reject', reason: 'claim_conflict' });
  });

  it('never preempts a stale_context conflict (only claim_held)', async () => {
    const decision = await capabilityPreemptPolicy(staleConflict);
    expect(decision).toEqual({ action: 'reject', reason: 'stale_context' });
  });
});

describe('ConflictDecision — protocol shape', () => {
  it('allow can carry an optional audit note', () => {
    const decision: ConflictDecision = {
      action: 'allow',
      note: 'org-level waiver active',
    };
    expect(decision).toMatchObject({ action: 'allow', note: expect.any(String) });
  });

  it('reject reason is optional — message-less rejection compiles', () => {
    const decision: ConflictDecision = { action: 'reject' };
    expect(decision.action).toBe('reject');
  });
});
