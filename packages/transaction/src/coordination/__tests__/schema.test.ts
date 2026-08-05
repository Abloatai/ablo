/**
 * Canonical coordination wire-schema tests. Locks the three-layer structure
 * and the invariants the WS ingest relies on (see `../schema.ts`):
 *   - required vs optional fields per layer,
 *   - the optimistic write-guard fields living ON the commit operation,
 *   - the claim claim being a superset of the SDK's historical view.
 */

import {
  onStaleModeSchema,
  commitReadSetEntrySchema,
  persistedReadSetEntrySchema,
  readSetEntrySchema,
  readSetSchema,
  readDependencySchema,
  staleNotificationSchema,
  trackDependencySchema,
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
    it('onStale accepts the three modes and rejects unknown', () => {
      for (const m of ['reject', 'overwrite', 'notify']) {
        expect(onStaleModeSchema.safeParse(m).success).toBe(true);
      }
      expect(onStaleModeSchema.safeParse('clobber').success).toBe(false);
      expect(onStaleModeSchema.safeParse('flag').success).toBe(false); // old name, renamed → notify
      expect(onStaleModeSchema.safeParse('force').success).toBe(false); // old name, renamed → overwrite
      expect(onStaleModeSchema.safeParse('merge').success).toBe(false); // removed
    });

    describe('ReadSet is the canonical decision-input structure', () => {
      it('models an exact commit-lifetime row or group read', () => {
        expect(commitReadSetEntrySchema.parse({
          target: { scope: 'row', model: 'Task', id: 't1', fields: ['status'] },
          watermark: 17,
          lifetime: 'commit',
          onStale: 'reject',
        })).toEqual({
          target: { scope: 'row', model: 'Task', id: 't1', fields: ['status'] },
          watermark: 17,
          lifetime: 'commit',
          onStale: 'reject',
        });
        expect(commitReadSetEntrySchema.safeParse({
          target: { scope: 'group', group: 'report:abc' },
          watermark: 18,
          lifetime: 'commit',
          onStale: 'notify',
        }).success).toBe(true);
      });

      it('makes persisted lifetime and narrowed disposition explicit', () => {
        expect(persistedReadSetEntrySchema.safeParse({
          target: { scope: 'row', model: 'Task', id: 't1' },
          watermark: 17,
          lifetime: 'persisted',
          onStale: 'notify',
        }).success).toBe(true);
        expect(persistedReadSetEntrySchema.safeParse({
          target: { scope: 'row', model: 'Task', id: 't1' },
          watermark: 17,
          lifetime: 'persisted',
          onStale: 'overwrite',
        }).success).toBe(false);
      });

      it('requires resolved watermarks internally while track keeps its wire default', () => {
        expect(persistedReadSetEntrySchema.safeParse({
          target: { scope: 'group', group: 'report:abc' },
          lifetime: 'persisted',
          onStale: 'notify',
        }).success).toBe(false);
        expect(trackDependencySchema.safeParse({ group: 'report:abc' }).success).toBe(true);
      });

      it('forms one lifetime-discriminated collection', () => {
        const entries = [
          {
            target: { scope: 'row' as const, model: 'Task', id: 't1' },
            watermark: 17,
            lifetime: 'commit' as const,
            onStale: 'reject' as const,
          },
          {
            target: { scope: 'group' as const, group: 'report:abc' as const },
            watermark: 17,
            lifetime: 'persisted' as const,
            onStale: 'notify' as const,
          },
        ];
        expect(readSetSchema.parse(entries)).toEqual(entries);
        expect(entries.every((entry) => readSetEntrySchema.safeParse(entry).success)).toBe(true);
      });

      it('uses one nonnegative integer watermark domain for every entry', () => {
        const entry = {
          target: { scope: 'row' as const, model: 'Task', id: 't1' },
          lifetime: 'commit' as const,
          onStale: 'reject' as const,
        };
        expect(commitReadSetEntrySchema.safeParse({ ...entry, watermark: 0 }).success).toBe(true);
        expect(commitReadSetEntrySchema.safeParse({ ...entry, watermark: -1 }).success).toBe(false);
        expect(commitReadSetEntrySchema.safeParse({ ...entry, watermark: 1.5 }).success).toBe(false);
        expect(readDependencySchema.safeParse({ model: 'Task', id: 't1', readAt: -1 }).success)
          .toBe(false);
      });
    });

    it('staleNotificationSchema validates a notify-instead-of-abort signal', () => {
      const parsed = staleNotificationSchema.safeParse({
        object: 'stale_notification',
        scope: 'row',
        target: { model: 'task', id: 't1', fields: ['status'] },
        readAt: 10,
        observedSyncId: 12,
        currentValues: { status: 'done' },
        writtenBy: { kind: 'agent', id: 'agent-1' },
      });
      expect(parsed.success).toBe(true);
    });

    it('a group notification names the row that moved AND the premise it broke', () => {
      const parsed = staleNotificationSchema.safeParse({
        object: 'stale_notification',
        scope: 'group',
        // The moved row, two hops below the group's scope root — NOT the group
        // key restated as a row, which is what this used to carry.
        target: { model: 'SlideLayer', id: 'L-9', fields: ['fill'] },
        group: 'deck:d-1',
        propagation: { via: 'transitive', through: ['slides', 'decks'] },
        readAt: 10,
        observedSyncId: 12,
        writtenBy: { kind: 'agent', id: 'agent-1' },
      });
      expect(parsed.success).toBe(true);
      // Narrowing on `scope` is what makes the group-only fields reachable.
      if (parsed.success && parsed.data.scope === 'group') {
        expect(parsed.data.group).toBe('deck:d-1');
        expect(parsed.data.propagation?.via).toBe('transitive');
        expect(parsed.data.target.id).toBe('L-9');
      }
    });

    it('a group notification can report how much of the group moved', () => {
      const parsed = staleNotificationSchema.safeParse({
        object: 'stale_notification',
        scope: 'group',
        target: { model: 'SlideLayer', id: 'L-9', fields: ['fill'] },
        group: 'deck:d-1',
        // The signal that lets an actor decline to re-read: 12k rows moved and
        // the sample names only the newest few.
        changed: {
          count: 12_403,
          sample: [{ model: 'SlideLayer', id: 'L-9' }],
          truncated: true,
        },
        readAt: 10,
        observedSyncId: 12,
        writtenBy: { kind: 'agent', id: 'agent-1' },
      });
      expect(parsed.success).toBe(true);
      if (parsed.success && parsed.data.scope === 'group') {
        expect(parsed.data.changed?.count).toBe(12_403);
        expect(parsed.data.changed?.truncated).toBe(true);
      }
    });

    it('a group notification requires a well-formed group key', () => {
      const parsed = staleNotificationSchema.safeParse({
        object: 'stale_notification',
        scope: 'group',
        target: { model: 'SlideLayer', id: 'L-9', fields: [] },
        group: 'not-a-group-key', // no `kind:id` — matches nothing, so it is rejected
        readAt: 10,
        observedSyncId: 12,
        writtenBy: { kind: 'agent', id: 'agent-1' },
      });
      expect(parsed.success).toBe(false);
    });

    it('staleNotificationSchema rejects a bad participant kind', () => {
      const parsed = staleNotificationSchema.safeParse({
        object: 'stale_notification',
        scope: 'row',
        target: { model: 'task', id: 't1', fields: [] },
        readAt: 10,
        observedSyncId: 12,
        currentValues: {},
        writtenBy: { kind: 'robot', id: 'x' },
      });
      expect(parsed.success).toBe(false);
    });

    it('the write-guard fields live ON the commit operation', () => {
      const parsed = commitOperationSchema.safeParse({
        type: 'UPDATE',
        model: 'Task',
        id: 't1',
        input: { status: 'done' },
        readAt: 1748160000000,
        onStale: 'reject',
        bypass: false,
      });
      expect(parsed.success).toBe(true);
    });

    it('a bare operation (no guard) is valid — unguarded writes are allowed', () => {
      expect(
        commitOperationSchema.safeParse({ type: 'CREATE', model: 'Task' }).success,
      ).toBe(true);
    });

    // `track` is a projection of `reads`, and these are the three ways the
    // projection says they differ. Pinned behaviorally rather than by comparing
    // the two shapes, which would only prove the copy matches itself.
    describe('track is the durable projection of reads', () => {
      it('names its target the same way, at both grains', () => {
        expect(trackDependencySchema.safeParse({ model: 'Task', id: 't1' }).success).toBe(true);
        expect(trackDependencySchema.safeParse({ group: 'report:abc' }).success).toBe(true);
      });

      it('makes readAt optional, where a read premise requires it', () => {
        expect(trackDependencySchema.safeParse({ group: 'report:abc' }).success).toBe(true);
        expect(readDependencySchema.safeParse({ group: 'report:abc' }).success).toBe(false);
      });

      it('carries a NARROWED disposition and no field grain', () => {
        const parsed = trackDependencySchema.parse({
          model: 'Task',
          id: 't1',
          onStale: 'reject',
          fields: ['status'],
        });
        // The disposition survives — it is what decides whether a moved belief
        // merely reports or gates the tracker's next write.
        expect(parsed).toMatchObject({ onStale: 'reject' });
        // The field grain does not: `track_dependencies` has no column to store
        // one in, so a track fires at row grain.
        expect(parsed).not.toHaveProperty('fields');
      });

      it('defaults to notify, so an existing track is unchanged', () => {
        const parsed = trackDependencySchema.parse({ model: 'Task', id: 't1' });
        expect(parsed).not.toHaveProperty('onStale'); // server default: 'notify'
      });

      it('excludes overwrite — a track guards no write of its own to apply', () => {
        expect(
          trackDependencySchema.safeParse({ model: 'Task', id: 't1', onStale: 'overwrite' })
            .success,
        ).toBe(false);
        // The read premise, which DOES guard a write, still accepts it.
        expect(
          readDependencySchema.safeParse({
            model: 'Task',
            id: 't1',
            readAt: 7,
            onStale: 'overwrite',
          }).success,
        ).toBe(true);
      });

      it('a read premise keeps both', () => {
        const parsed = readDependencySchema.parse({
          model: 'Task',
          id: 't1',
          readAt: 7,
          onStale: 'reject',
          fields: ['status'],
        });
        expect(parsed).toMatchObject({ onStale: 'reject', fields: ['status'] });
      });
    });
  });

  describe('layer 2 — pessimistic claim / claim', () => {
    it('claim_begin requires claimId + target; description optional', () => {
      // Description-first — the current field.
      expect(
        claimBeginPayloadSchema.safeParse({
          claimId: 'i1',
          entityType: 'Task',
          entityId: 't1',
          description: 'rewriting the risk section',
          queue: true,
        }).success,
      ).toBe(true);

      // A second claim carries its work text in `description`.
      expect(
        claimBeginPayloadSchema.safeParse({
          claimId: 'i1',
          entityType: 'Task',
          entityId: 't1',
          description: 'editing',
        }).success,
      ).toBe(true);

      // A bare claim (no description) is valid — the server defaults to 'editing'.
      expect(
        claimBeginPayloadSchema.safeParse({
          claimId: 'i1',
          entityType: 'Task',
          entityId: 't1',
        }).success,
      ).toBe(true);

      // claimId is still required.
      expect(
        claimBeginPayloadSchema.safeParse({ entityType: 'Task', entityId: 't1' })
          .success,
      ).toBe(false);
    });

    it('claim_abandon carries optional entityType/entityId for dequeueing waiters', () => {
      expect(claimAbandonPayloadSchema.safeParse({ claimId: 'i1' }).success).toBe(
        true,
      );
      const withTarget = claimAbandonPayloadSchema.safeParse({
        claimId: 'i1',
        entityType: 'Task',
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
        entityType: 'Task',
        entityId: 't1',
        description: 'editing',
        declaredAt: 1,
        expiresAt: 2,
      });
      expect(view.success).toBe(true);
      // …another frame carrying its work text in `description` still parses…
      const legacy = wireClaimSchema.safeParse({
        claimId: 'i1',
        entityType: 'Task',
        entityId: 't1',
        description: 'editing',
        declaredAt: 1,
        expiresAt: 2,
      });
      expect(legacy.success).toBe(true);
      // …and so does the full server shape with lifecycle fields.
      const full = wireClaimSchema.safeParse({
        claimId: 'i1',
        entityType: 'Task',
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
        policyReason: 'same row is already being reformatted',
        heldByClaim: {
          claimId: 'claim-a',
          entityType: 'Task',
          entityId: 't1',
          description: 'reformatting the pricing table',
          declaredAt: 1748160000000,
          expiresAt: 1748160300000,
        },
      });
      expect(rich.success).toBe(true);
      if (!rich.success) return;
      expect(rich.data.heldByClaim?.description).toBe('reformatting the pricing table');
      expect(rich.data.policyReason).toBe('same row is already being reformatted');
    });

    // Two refusals, two decisions: `conflict` means someone holds the row and
    // you may queue behind them; `coordination_unavailable` means nothing is
    // known about it. A free string made those one value, so a caller could
    // not branch. The wire spelling is frozen, so an unrecognised word from an
    // older server drops to absent rather than arriving as prose — prose has
    // its own field in `policyReason`.
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
        policyReason: 'the policy said no',
      });
      expect(older.success).toBe(true);
      if (older.success) {
        expect(older.data.reason).toBeUndefined();
        // The frame still parses, and the prose it carried is not lost.
        expect(older.data.policyReason).toBe('the policy said no');
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
        target: { entityType: 'Task', entityId: 't1' },
        heldBy: 'agent:pulse',
        heldByClaimId: 'claim-a',
        heldByExpiresAt: 1748160300000,
        heldByClaim: {
          claimId: 'claim-a',
          entityType: 'Task',
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
            entityType: 'Task',
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
