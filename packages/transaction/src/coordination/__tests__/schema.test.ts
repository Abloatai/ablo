/**
 * Canonical coordination wire-schema tests. Locks the three-layer structure
 * and the invariants the WS ingest relies on (see `../schema.ts`):
 *   - required vs optional fields per layer,
 *   - the optimistic write-guard fields living ON the commit operation,
 *   - the claim claim being a superset of the SDK's historical view.
 */

import {
  readDependencySchema,
  wireClaimStatusSchema,
  wireClaimSchema,
  claimErrorSchema,
  claimRejectionSchema,
  targetRefSchema,
  claimBeginPayloadSchema,
  claimAbandonPayloadSchema,
  commitOperationSchema,
  presenceUpdateSchema,
  participantKindFromWire,
} from '@abloatai/transaction/coordination/schema';

describe('coordination wire schema', () => {
  describe('layer 3 — optimistic stale-context', () => {
    it('records compact row and group reads with a nonnegative integer readAt', () => {
      expect(readDependencySchema.parse({
        model: 'Item', id: 't1', fields: ['status'], readAt: 17,
      })).toEqual({
        model: 'Item', id: 't1', fields: ['status'], readAt: 17,
      });
      expect(readDependencySchema.safeParse({
        group: 'report:abc', readAt: 18,
      }).success).toBe(true);
      expect(readDependencySchema.safeParse({ model: 'Item', id: 't1', readAt: -1 }).success)
        .toBe(false);
      expect(readDependencySchema.safeParse({ model: 'Item', id: 't1', readAt: 1.5 }).success)
        .toBe(false);
    });

    // Stale premises reject; there is no success-with-notification receipt.

    it('the write-guard fields live ON the commit operation', () => {
      const parsed = commitOperationSchema.safeParse({
        type: 'UPDATE',
        model: 'Item',
        id: 't1',
        input: { status: 'done' },
        readAt: 1748160000000,
      });
      expect(parsed.success).toBe(true);
    });

    it('a bare operation (no guard) is valid — unguarded writes are allowed', () => {
      expect(
        commitOperationSchema.safeParse({ type: 'CREATE', model: 'Item' }).success,
      ).toBe(true);
    });

    it('a read premise keeps its field grain', () => {
      const parsed = readDependencySchema.parse({
        model: 'Item',
        id: 't1',
        readAt: 7,
        fields: ['status'],
      });
      expect(parsed).toMatchObject({ fields: ['status'] });
    });
  });

  describe('layer 2 — pessimistic claim / claim', () => {
    it('claim_begin requires claimId + target; description optional', () => {
      // Description-first — the current field.
      expect(
        claimBeginPayloadSchema.safeParse({
          claimId: 'i1',
          entityType: 'Item',
          entityId: 't1',
          description: 'rewriting the risk section',
          queue: true,
        }).success,
      ).toBe(true);

      // A second claim carries its work text in `description`.
      expect(
        claimBeginPayloadSchema.safeParse({
          claimId: 'i1',
          entityType: 'Item',
          entityId: 't1',
          description: 'editing',
        }).success,
      ).toBe(true);

      // A bare claim (no description) is valid — the server defaults to 'editing'.
      expect(
        claimBeginPayloadSchema.safeParse({
          claimId: 'i1',
          entityType: 'Item',
          entityId: 't1',
        }).success,
      ).toBe(true);

      // claimId is still required.
      expect(
        claimBeginPayloadSchema.safeParse({ entityType: 'Item', entityId: 't1' })
          .success,
      ).toBe(false);
    });

    it('claim_abandon carries optional entityType/entityId for dequeueing waiters', () => {
      expect(claimAbandonPayloadSchema.safeParse({ claimId: 'i1' }).success).toBe(
        true,
      );
      const withTarget = claimAbandonPayloadSchema.safeParse({
        claimId: 'i1',
        entityType: 'Item',
        entityId: 't1',
      });
      expect(withTarget.success).toBe(true);
      expect(claimAbandonPayloadSchema.safeParse({}).success).toBe(false);
    });

    it('claimStatus is the four lifecycle states', () => {
      for (const s of ['active', 'committed', 'expired', 'canceled']) {
        expect(wireClaimStatusSchema.safeParse(s).success).toBe(true);
      }
      expect(wireClaimStatusSchema.safeParse('pending').success).toBe(false);
    });

    it('claim claim is a superset of the SDK view — status/error optional', () => {
      // SDK-shaped (no status/error), description-first, parses…
      const view = wireClaimSchema.safeParse({
        claimId: 'i1',
        entityType: 'Item',
        entityId: 't1',
        description: 'editing',
        declaredAt: 1,
        expiresAt: 2,
      });
      expect(view.success).toBe(true);
      // …another frame carrying its work text in `description` still parses…
      const legacy = wireClaimSchema.safeParse({
        claimId: 'i1',
        entityType: 'Item',
        entityId: 't1',
        description: 'editing',
        declaredAt: 1,
        expiresAt: 2,
      });
      expect(legacy.success).toBe(true);
      // …and so does the full server shape with lifecycle fields.
      const full = wireClaimSchema.safeParse({
        claimId: 'i1',
        entityType: 'Item',
        entityId: 't1',
        description: 'editing',
        declaredAt: 1,
        expiresAt: 2,
        status: 'committed',
        error: { code: 'x' },
      });
      expect(full.success).toBe(true);
    });

    it('claim errors can carry optional holder context and still accept legacy frames', () => {
      const legacy = claimErrorSchema.safeParse({
        code: 'claim_conflict',
        heldBy: 'agent:pulse',
        heldByClaimId: 'claim-a',
        heldByExpiresAt: 1748160300000,
      });
      expect(legacy.success).toBe(true);

      const rich = claimErrorSchema.safeParse({
        code: 'claim_conflict',
        message: 'held by peer',
        heldBy: 'agent:pulse',
        heldByClaimId: 'claim-a',
        heldByExpiresAt: 1748160300000,
        message: 'same row is already being reformatted',
        heldByClaim: {
          claimId: 'claim-a',
          entityType: 'Item',
          entityId: 't1',
          description: 'reformatting the pricing table',
          declaredAt: 1748160000000,
          expiresAt: 1748160300000,
        },
      });
      expect(rich.success).toBe(true);
      if (!rich.success) return;
      expect(rich.data.heldByClaim?.description).toBe('reformatting the pricing table');
      expect(rich.data.message).toBe('same row is already being reformatted');
    });

    // Two refusals, two decisions: `conflict` means someone holds the row and
    // you may queue behind them; `coordination_unavailable` means nothing is
    // known about it. A free string made those one value, so a caller could
    // not branch. The wire spelling is frozen, so an unrecognised word from an
    // older server drops to absent rather than arriving as prose — prose has
    // its own field in `message`.
    it('types the refusal reason and drops a word it does not know', () => {
      const known = claimRejectionSchema.safeParse({
        claimId: 'claim-r',
        reason: 'coordination_unavailable',
      });
      expect(known.success).toBe(true);
      if (known.success) expect(known.data.reason).toBe('coordination_unavailable');

      const older = claimRejectionSchema.safeParse({
        claimId: 'claim-r',
        reason: 'some_word_a_newer_server_invented',
        message: 'claim denied',
      });
      expect(older.success).toBe(true);
      if (older.success) {
        expect(older.data.reason).toBeUndefined();
        // The frame still parses, and the prose it carried is not lost.
        expect(older.data.message).toBe('claim denied');
      }
    });

    // A packed part name is several names wearing one. `blocks:b_1,b_2` and
    // `blocks:b_1` compare as unrelated, so both writers were granted the same
    // part and one update was lost with nothing raised. `fields` says it
    // properly; the refusal is what makes the mistake visible where it is made.
    it('refuses a part name that is plainly several, and points at fields', () => {
      const packed = targetRefSchema.safeParse({
        entityType: 'Document',
        entityId: 'd1',
        field: 'blocks:b_3,b_7',
      });
      expect(packed.success).toBe(false);
      if (!packed.success) {
        expect(packed.error.issues[0]?.message).toContain('fields');
      }

      // The same names, said properly.
      expect(
        targetRefSchema.safeParse({
          entityType: 'Document',
          entityId: 'd1',
          fields: ['blocks:b_3', 'blocks:b_7'],
        }).success,
      ).toBe(true);

      // And an ordinary name is untouched — the rule is narrow on purpose.
      expect(
        targetRefSchema.safeParse({
          entityType: 'Document',
          entityId: 'd1',
          field: 'content',
        }).success,
      ).toBe(true);
    });

    it('claim rejections carry the same optional holder context', () => {
      const parsed = claimRejectionSchema.safeParse({
        claimId: 'claim-b',
        reason: 'conflict',
        target: { entityType: 'Item', entityId: 't1' },
        heldBy: 'agent:pulse',
        heldByClaimId: 'claim-a',
        heldByExpiresAt: 1748160300000,
        heldByClaim: {
          claimId: 'claim-a',
          entityType: 'Item',
          entityId: 't1',
          description: 'reformatting',
          declaredAt: 1748160000000,
          expiresAt: 1748160300000,
          meta: { description: 'pricing table' },
        },
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe('layer 1 — presence (observation)', () => {
    it('a presence frame carries activeClaims as canonical claim claims', () => {
      const parsed = presenceUpdateSchema.safeParse({
        kind: 'update',
        userId: 'agent:a',
        status: 'online',
        activeClaims: [
          {
            claimId: 'i1',
            entityType: 'Item',
            entityId: 't1',
            description: 'editing',
            declaredAt: 1,
            expiresAt: 2,
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });

    it('a presence frame carries the canonical participantKind, normalizing legacy human', () => {
      const system = presenceUpdateSchema.safeParse({
        kind: 'update',
        userId: 'system:reaper',
        status: 'online',
        participantKind: 'system',
      });
      expect(system.success).toBe(true);
      if (system.success) expect(system.data.participantKind).toBe('system');

      const legacy = presenceUpdateSchema.safeParse({
        kind: 'update',
        userId: 'u1',
        status: 'online',
        participantKind: 'human',
      });
      expect(legacy.success).toBe(true);
      if (legacy.success) expect(legacy.data.participantKind).toBe('user');
    });

    it('participantKindFromWire prefers the stamped kind, falls back to isAgent', () => {
      expect(participantKindFromWire('system', false)).toBe('system');
      expect(participantKindFromWire('human', false)).toBe('user'); // legacy normalize
      expect(participantKindFromWire(undefined, true)).toBe('agent'); // old-server fallback
      expect(participantKindFromWire(undefined, undefined)).toBe('user');
      expect(participantKindFromWire('gibberish', true)).toBe('agent'); // never widen
    });
  });
});
