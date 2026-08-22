import { z } from 'zod';
import {
  commitAckSchema,
  commitClaimReferenceSchema,
  commitExecutionResultSchema,
  commitRecordSchema,
  commitReceiptSchema,
  commitRequestSchema,
  commitStatusSchema,
  commitWaitSchema,
  mutationResultPayloadSchema,
} from '@abloatai/transaction/wire/commit';

const CREATED_AT = '2026-08-05T10:00:00.000Z';
const STATUS_AT = '2026-08-05T10:00:00.058Z';
const authority = {
  organizationId: 'org-1', projectId: 'project-1', branchId: 'branch-1',
  syncGroups: ['org:org-1'], operations: [],
  participantKind: 'agent' as const, participantId: 'researcher-1', deliveryPartition: null,
};

const confirmedStatus = {
  status: 'confirmed' as const,
  statusAt: STATUS_AT,
  lastSyncId: 41,
};

const confirmedReceipt = {
  ...confirmedStatus,
  object: 'commit_receipt' as const,
  clientTxId: 'client-1',
  serverTxId: '41',
  createdAt: CREATED_AT,
  success: true as const,
  ops: 1,
  authority,
};

describe('canonical commit status', () => {
  it('records a claim as identity, exact row target, and fence evidence', () => {
    expect(commitClaimReferenceSchema.parse({
      id: 'claim-1',
      target: { scope: 'row', model: 'items', id: 'item-1' },
      fenceToken: 7,
    })).toEqual({
      id: 'claim-1',
      target: { scope: 'row', model: 'items', id: 'item-1' },
      fenceToken: 7,
    });
    expect(commitClaimReferenceSchema.safeParse({
      id: 'claim-1',
      target: { scope: 'row', model: 'items', id: 'item-1' },
    }).success).toBe(false);
  });

  it('owns all three lifecycle variants and derives the status name type', () => {
    expect(commitStatusSchema.parse({
      status: 'queued',
      statusAt: STATUS_AT,
      lastSyncId: 0,
      correlationId: 'corr-1',
    })).toMatchObject({ status: 'queued', lastSyncId: 0 });
    expect(commitStatusSchema.parse(confirmedStatus)).toEqual(confirmedStatus);
    expect(commitStatusSchema.parse({ status: 'rejected', statusAt: STATUS_AT })).toEqual({
      status: 'rejected',
      statusAt: STATUS_AT,
    });
  });

  it('derives the wait subset without allowing rejected', () => {
    expect(commitWaitSchema.parse('queued')).toBe('queued');
    expect(commitWaitSchema.parse('confirmed')).toBe('confirmed');
    expect(commitWaitSchema.safeParse('rejected').success).toBe(false);
  });

  it('requires queued correlation at lastSyncId zero', () => {
    const queued = { status: 'queued', statusAt: STATUS_AT, lastSyncId: 0, correlationId: 'corr' };
    expect(commitStatusSchema.parse(queued)).toEqual(queued);
    expect(commitStatusSchema.safeParse({ ...queued, correlationId: undefined }).success).toBe(false);
    expect(commitStatusSchema.safeParse({ ...queued, lastSyncId: 1 }).success).toBe(false);
  });

  it('requires a positive lastSyncId for source-correlated confirmation', () => {
    expect(commitStatusSchema.safeParse({
      ...confirmedStatus,
      lastSyncId: 0,
      correlationId: 'corr',
    }).success).toBe(false);
    expect(commitStatusSchema.parse({
      ...confirmedStatus,
      correlationId: 'corr',
    })).toMatchObject({ correlationId: 'corr', lastSyncId: 41 });
  });

  it('derives JSON Schema for every exported commit boundary', () => {
    for (const schema of [
      commitStatusSchema,
      commitWaitSchema,
      commitReceiptSchema,
      mutationResultPayloadSchema,
      commitExecutionResultSchema,
      commitAckSchema,
      commitRecordSchema,
    ]) {
      expect(() => z.toJSONSchema(schema)).not.toThrow();
    }
  });
});

describe('derived boundary projections', () => {
  it('accepts hosted and source-confirmed receipts', () => {
    expect(commitReceiptSchema.parse(confirmedReceipt)).toEqual(confirmedReceipt);
    expect(commitReceiptSchema.parse({
      ...confirmedReceipt,
      correlationId: 'corr-source',
    })).toMatchObject({ status: 'confirmed', lastSyncId: 41, correlationId: 'corr-source' });
  });

  it('returns transaction-bound rows without adding them to the durable execution result', () => {
    const operationResults = [
      {
        transactionId: 'record-transition',
        outcome: 'updated' as const,
        row: { id: 'record-1', status: 'running' },
      },
    ];
    expect(commitReceiptSchema.parse({
      ...confirmedReceipt,
      operationResults,
    })).toMatchObject({ operationResults });

    expect(commitExecutionResultSchema.safeParse({
      status: 'confirmed',
      createdAt: CREATED_AT,
      statusAt: STATUS_AT,
      firstSyncId: 41,
      lastSyncId: 41,
      operationResults,
    }).success).toBe(false);
  });

  it('rejects old and contradictory receipt fields', () => {
    expect(commitReceiptSchema.safeParse({ ...confirmedReceipt, watermark: 41 }).success).toBe(false);
    expect(commitReceiptSchema.safeParse({ ...confirmedReceipt, status: 'rejected' }).success).toBe(false);
  });

  it('keeps rejection free of confirmation evidence', () => {
    const rejected = {
      object: 'commit_receipt' as const,
      clientTxId: 'client-1',
      serverTxId: '',
      createdAt: CREATED_AT,
      success: false as const,
      status: 'rejected' as const,
      statusAt: STATUS_AT,
      authority,
      error: { code: 'write_options_invalid', message: 'invalid write' },
    };
    expect(mutationResultPayloadSchema.parse(rejected)).toEqual(rejected);
    expect(mutationResultPayloadSchema.safeParse({ ...rejected, lastSyncId: 1 }).success).toBe(false);
    expect(mutationResultPayloadSchema.safeParse({ ...rejected, correlationId: 'corr' }).success).toBe(false);
  });

  it('stores explicit status and canonical acknowledgement evidence', () => {
    const queued = {
      status: 'queued' as const,
      statusAt: STATUS_AT,
      lastSyncId: 0 as const,
      correlationId: 'corr-source',
      createdAt: CREATED_AT,
      firstSyncId: 0,
      confirmationTransactionIds: ['ablo_echo_tx_v1:["corr-source","op-1"]'],
    };
    expect(commitExecutionResultSchema.parse(queued)).toEqual(queued);
    expect(commitExecutionResultSchema.safeParse({
      firstSyncId: 1,
      lastSyncId: 2,
    }).success).toBe(false);
    expect(commitAckSchema.parse({
      status: 'queued',
      statusAt: STATUS_AT,
      lastSyncId: 0,
      correlationId: 'corr-source',
    })).toMatchObject({ status: 'queued', lastSyncId: 0 });
  });

  it('requires server authority on every receipt', () => {
    const { authority: _authority, ...withoutAuthority } = confirmedReceipt;
    expect(commitReceiptSchema.safeParse(withoutAuthority).success).toBe(false);
  });

  it('does not accept client-claimed authority on a commit request', () => {
    expect(commitRequestSchema.safeParse({
      operations: [{ action: 'update', model: 'Item', data: {} }],
      authority,
    }).success).toBe(false);
  });
});

describe('flattened commit record', () => {
  const evidence = {
    id: 'commit-1',
    attempts: [{ id: 'request-1', observedAt: CREATED_AT, transport: 'http' as const, kind: 'execution' as const }],
    actor: { kind: 'agent' as const, id: 'researcher-1' },
    authority,
    claims: [],
    createdAt: CREATED_AT,
    readSet: [{
      target: { scope: 'row' as const, model: 'Item', id: 'item-1' },
      watermark: 17,
      lifetime: 'commit' as const,
      onStale: 'reject' as const,
    }],
    operations: [{ action: 'update', model: 'Item', id: 'item-1', data: { retention: 'redacted' } }],
    receipt: { clientTxId: 'commit-1', serverTxId: 'server-1', ops: 1 },
  };

  it('has one status location, one status time, and one confirmation position', () => {
    const record = commitRecordSchema.parse({ ...evidence, ...confirmedStatus });
    expect(record).toMatchObject({ status: 'confirmed', statusAt: STATUS_AT, lastSyncId: 41 });
    expect(record).not.toHaveProperty('confirmation');
    expect(record.receipt).not.toHaveProperty('status');
    expect(record.receipt).not.toHaveProperty('lastSyncId');
    expect(record.receipt).not.toHaveProperty('correlationId');
  });

  it('retains createdAt while a queued projection advances to confirmed', () => {
    const queued = commitRecordSchema.parse({
      ...evidence,
      status: 'queued',
      statusAt: CREATED_AT,
      lastSyncId: 0,
      correlationId: 'corr-1',
    });
    const confirmed = commitRecordSchema.parse({
      ...queued,
      status: 'confirmed',
      statusAt: STATUS_AT,
      lastSyncId: 41,
    });
    expect(confirmed.createdAt).toBe(queued.createdAt);
    expect(Date.parse(confirmed.statusAt)).toBeGreaterThan(Date.parse(queued.statusAt));
  });

  it('retains physical attempts without replacing earlier evidence', () => {
    expect(commitRecordSchema.parse({
      ...evidence,
      ...confirmedStatus,
      attempts: [...evidence.attempts, {
        id: 'request-2', observedAt: STATUS_AT, transport: 'http', kind: 'replay',
      }],
    })).toMatchObject({
      id: 'commit-1',
      attempts: [{ id: 'request-1' }, { id: 'request-2' }],
    });
  });

  it('rejects customer operation data from a durable record', () => {
    expect(commitRecordSchema.safeParse({
      ...evidence,
      ...confirmedStatus,
      operations: [{
        action: 'update',
        model: 'Item',
        id: 'item-1',
        data: { prompt: 'do not retain me' },
      }],
    }).success).toBe(false);
  });

  it('retains only a compact claim reference with its target and fence token', () => {
    const record = commitRecordSchema.parse({
      ...evidence,
      ...confirmedStatus,
      claims: [{
        id: 'claim-1',
        target: { scope: 'row', model: 'Item', id: 'item-1' },
        fenceToken: 12,
      }],
    });
    expect(record.claims).toEqual([{
      id: 'claim-1',
      target: { scope: 'row', model: 'Item', id: 'item-1' },
      fenceToken: 12,
    }]);
  });
});
