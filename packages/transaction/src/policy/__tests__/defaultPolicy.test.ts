/**
 * defaultPolicy — proves the `onStale` → decision mapping that powers
 * notify-instead-of-abort. Pure, no DB:
 *
 *   • stale_context + requestedMode 'notify' → notify (hold)
 *   • stale_context + 'reject' / absent      → reject (legacy behavior)
 *   • claim_held + agent committer           → reject (no-bypass invariant)
 *   • claim_held + system committer          → reject (sk_ writers serialize)
 *   • claim_held + user committer            → allow (Law 7: never blocked)
 *
 * `notify` is additive: a caller that doesn't opt in still gets the old
 * always-reject contract on the stale path.
 */

import { defaultPolicy } from '@abloatai/transaction/policy/types';
import type { StaleContextConflict, ClaimHeldConflict } from '@abloatai/transaction/policy/types';

const baseStale = (
  requestedMode?: StaleContextConflict['requestedMode'],
): StaleContextConflict => ({
  kind: 'stale_context',
  committer: { kind: 'agent', id: 'agent-1' },
  organizationId: 'org-1',
  operation: { model: 'item', id: 't-1', type: 'UPDATE', input: { status: 'x' } },
  readAt: 10,
  observedSyncId: 12,
  conflictingFields: ['status'],
  requestedMode,
});

describe('defaultPolicy — onStale mapping', () => {
  it("maps 'notify' to notify (hold)", async () => {
    const d = await defaultPolicy(baseStale('notify'));
    expect(d.action).toBe('notify');
  });

  it("maps 'reject' to reject", async () => {
    expect((await defaultPolicy(baseStale('reject'))).action).toBe('reject');
  });

  it('rejects when no mode is declared (unguarded-write default)', async () => {
    expect((await defaultPolicy(baseStale(undefined))).action).toBe('reject');
  });

  const claimHeldBy = (
    committer: ClaimHeldConflict['committer'],
  ): ClaimHeldConflict => ({
    kind: 'claim_held',
    committer,
    organizationId: 'org-1',
    heldBy: { kind: 'agent', id: 'agent-2' },
    claimId: 'claim-1',
    entityType: 'item',
    entityId: 't-1',
    expiresAt: Date.now() + 30_000,
    committerOperations: [],
  });

  it('rejects an AGENT committing into a claim_held conflict (no-bypass)', async () => {
    expect(
      (await defaultPolicy(claimHeldBy({ kind: 'agent', id: 'agent-1' }))).action,
    ).toBe('reject');
  });

  it('Law 7: allows a HUMAN committing into a claim_held conflict (never blocked)', async () => {
    expect(
      (await defaultPolicy(claimHeldBy({ kind: 'user', id: 'user-1' }))).action,
    ).toBe('allow');
  });

  it('rejects a SYSTEM committer on claim_held by default (sk_ writers serialize via claims; opt in with systemOverwrite)', async () => {
    expect(
      (await defaultPolicy(claimHeldBy({ kind: 'system', id: 'sys-1' }))).action,
    ).toBe('reject');
  });
});
