/**
 * P0 sync-delta decomposition — validates the decomposed Zod schemas parse a
 * representative stored row, the enums match the Postgres enums, and the plane
 * declarations keep customer-data classification separate from physical
 * storage. Pure; no IO.
 */

import {
  syncDeltaCoreSchema,
  deltaAttributionSchema,
  syncDeltaRowSchema,
  participantKindSchema,
  confirmationStateSchema,
  backfillProvenanceSchema,
  DELTA_DATA_CLASSIFICATION,
  DELTA_PHYSICAL_STORAGE,
} from '../../log/syncDeltaRow.js';

describe('sync-delta decomposition (P0)', () => {
  it('core accepts an outbox-marker-shaped change (no server-assigned fields)', () => {
    const parsed = syncDeltaCoreSchema.parse({
      actionType: 'U',
      modelName: 'documents',
      modelId: 'doc_1',
      data: { id: 'doc_1', title: 'hi' },
      organizationId: 'org_1',
      transactionId: 'tx_1',
    });
    expect(parsed.id).toBeUndefined(); // assigned control-plane on append
    expect(parsed.syncGroups).toBeUndefined();
    expect(parsed.modelId).toBe('doc_1');
  });

  it('core accepts a fully-appended row (id/syncGroups/createdAt present)', () => {
    expect(() =>
      syncDeltaCoreSchema.parse({
        id: 42n,
        actionType: 'D',
        modelName: 'documents',
        modelId: 'doc_1',
        data: null,
        syncGroups: ['org:org_1'],
        organizationId: 'org_1',
        createdAt: '2026-06-02T00:00:00.000Z',
        transactionId: null,
        sourceChangeId: 'wal:v1:source-row',
      }),
    ).not.toThrow();
  });

  it.each(['M', 'X', 'INSERT'])('rejects non-canonical action_type %s', (actionType) => {
    expect(() =>
      syncDeltaCoreSchema.parse({
        actionType,
        modelName: 'd',
        modelId: 'x',
        data: null,
        organizationId: 'o',
        transactionId: null,
      }),
    ).toThrow();
  });

  it('enums match the Postgres enum members', () => {
    expect(participantKindSchema.options).toEqual(['user', 'agent', 'system']);
    expect(confirmationStateSchema.options).toEqual([
      'auto',
      'previewed',
      'approved',
      'required_human_approval',
      'auto_historical',
    ]);
    expect(backfillProvenanceSchema.options).toEqual(['exact', 'inferred', 'unknown']);
  });

  it('attribution accepts nullable typed-attribution columns', () => {
    expect(() =>
      deltaAttributionSchema.parse({
        createdBy: 'user:u1',
        actorId: 'u1',
        actorKind: 'user',
        onBehalfOfId: null,
        onBehalfOfKind: null,
        capabilityId: null,
        confirmationState: 'auto',
        backfillProvenance: 'exact',
      }),
    ).not.toThrow();
  });

  it('full row = core ∪ attribution ∪ provenance', () => {
    const row = syncDeltaRowSchema.parse({
      id: 1n,
      actionType: 'I',
      modelName: 'd',
      modelId: 'x',
      data: { a: 1 },
      organizationId: 'o',
      transactionId: null,
      createdBy: null,
      actorId: 'u1',
      actorKind: 'user',
      onBehalfOfId: null,
      onBehalfOfKind: null,
      capabilityId: null,
      confirmationState: 'auto',
      backfillProvenance: 'exact',
    });
    expect(row.actorKind).toBe('user');
  });

  it('classifies retained row payload separately from its physical storage', () => {
    expect(DELTA_DATA_CLASSIFICATION.core).toBe('customer-data');
    expect(DELTA_DATA_CLASSIFICATION.attribution).toBe('control-metadata');
    expect(DELTA_PHYSICAL_STORAGE).toEqual({
      core: 'control',
      attribution: 'control',
    });
  });
});
