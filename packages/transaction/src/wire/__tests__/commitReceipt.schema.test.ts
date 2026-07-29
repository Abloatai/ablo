import {
  commitAckSchema,
  commitExecutionResultSchema,
  commitReceiptSchema,
  mutationResultPayloadSchema,
} from '@abloatai/transaction/wire/commit';

const confirmedReceipt = {
  object: 'commit_receipt' as const,
  clientTxId: 'client-1',
  serverTxId: '41',
  success: true as const,
  status: 'confirmed' as const,
  lastSyncId: 41,
  ops: 1,
};

describe('canonical commit settlement receipts', () => {
  it('accepts hosted and source-confirmed receipts through the same schema', () => {
    expect(commitReceiptSchema.parse(confirmedReceipt)).toEqual(confirmedReceipt);

    expect(
      commitReceiptSchema.parse({
        ...confirmedReceipt,
        correlationId: 'corr-source-1',
      })
    ).toMatchObject({
      status: 'confirmed',
      correlationId: 'corr-source-1',
      lastSyncId: 41,
    });
  });

  it('requires zero watermark plus a non-empty correlation for queued receipts', () => {
    const queued = {
      ...confirmedReceipt,
      serverTxId: '0',
      status: 'queued' as const,
      correlationId: 'corr-source-queued',
      lastSyncId: 0,
      confirmationTransactionIds: ['server-internal-must-not-cross-wire'],
    };
    expect(commitReceiptSchema.parse(queued)).toEqual({
      object: 'commit_receipt',
      clientTxId: 'client-1',
      serverTxId: '0',
      success: true,
      status: 'queued',
      correlationId: 'corr-source-queued',
      lastSyncId: 0,
      ops: 1,
    });

    expect(
      commitReceiptSchema.safeParse({
        ...queued,
        correlationId: undefined,
      }).success
    ).toBe(false);
    expect(
      commitReceiptSchema.safeParse({
        ...queued,
        correlationId: '',
      }).success
    ).toBe(false);
    expect(
      commitReceiptSchema.safeParse({
        ...queued,
        lastSyncId: 1,
      }).success
    ).toBe(false);
  });

  it('does not allow source confirmation without a durable watermark', () => {
    expect(
      commitReceiptSchema.safeParse({
        ...confirmedReceipt,
        correlationId: 'corr-source-zero',
        lastSyncId: 0,
      }).success
    ).toBe(false);
  });

  it('keeps success and rejection arms contradictory by construction', () => {
    expect(
      mutationResultPayloadSchema.safeParse({
        ...confirmedReceipt,
        success: false,
      }).success
    ).toBe(false);
    expect(
      mutationResultPayloadSchema.safeParse({
        ...confirmedReceipt,
        status: 'rejected',
      }).success
    ).toBe(false);
  });

  it('preserves actionable diagnostics on a rejected WebSocket commit', () => {
    const rejected = mutationResultPayloadSchema.parse({
      object: 'commit_receipt',
      clientTxId: 'client-1',
      serverTxId: '',
      success: false,
      status: 'rejected',
      error: {
        code: 'capability_scope_denied',
        message: 'Postgres row-level security rejected this write.',
        request_id: 'req_ws_123',
        requiredCapability: { scope: 'documents.create' },
        details: {
          origin: 'database_row_level_security',
          resolvedCapability: 'allowed',
        },
      },
    });
    expect(rejected.error).toMatchObject({
      request_id: 'req_ws_123',
      requiredCapability: { scope: 'documents.create' },
      details: {
        origin: 'database_row_level_security',
        resolvedCapability: 'allowed',
      },
    });
  });

  it('requires every settlement field a receipt claims, inventing none', () => {
    // Settlement is declared, not inferred. A receipt that omits `status`,
    // `object`, `serverTxId`, or `ops` is refused rather than back-filled, so a
    // producer cannot report a write as confirmed by staying silent.
    for (const omitted of ['object', 'status', 'serverTxId', 'ops'] as const) {
      const { [omitted]: _dropped, ...partial } = confirmedReceipt;
      expect(commitReceiptSchema.safeParse(partial).success).toBe(false);
    }

    // A stringly-typed watermark is a different shape, not a spelling of this
    // one — it is refused rather than coerced.
    expect(
      commitReceiptSchema.safeParse({ ...confirmedReceipt, lastSyncId: '9' }).success
    ).toBe(false);
  });
});

describe('server execution and client acknowledgement projections', () => {
  const confirmationTransactionIds = ['ablo_echo_tx_v1:["corr-source","op-1"]'];

  it('normalizes legacy hosted cache rows to explicit confirmed status', () => {
    expect(commitExecutionResultSchema.parse({ firstSyncId: 1, lastSyncId: 2 })).toEqual({
      firstSyncId: 1,
      lastSyncId: 2,
      status: 'confirmed',
    });
  });

  it('requires complete coupled recovery evidence for queued and confirmed source rows', () => {
    const queued = {
      firstSyncId: 0,
      lastSyncId: 0,
      status: 'queued' as const,
      correlationId: 'corr-source',
      confirmationTransactionIds,
    };
    expect(commitExecutionResultSchema.parse(queued)).toEqual(queued);
    expect(
      commitExecutionResultSchema.safeParse({
        ...queued,
        correlationId: undefined,
      }).success
    ).toBe(false);
    expect(
      commitExecutionResultSchema.safeParse({
        ...queued,
        confirmationTransactionIds: undefined,
      }).success
    ).toBe(false);

    const confirmed = {
      ...queued,
      firstSyncId: 51,
      lastSyncId: 52,
      status: 'confirmed' as const,
    };
    expect(commitExecutionResultSchema.parse(confirmed)).toEqual(confirmed);
    expect(
      commitExecutionResultSchema.safeParse({
        ...confirmed,
        firstSyncId: 0,
        lastSyncId: 0,
      }).success
    ).toBe(false);
  });

  it('uses the same queued invariant for normalized client acknowledgements', () => {
    expect(
      commitAckSchema.parse({
        status: 'queued',
        correlationId: 'corr-ack',
        lastSyncId: 0,
      })
    ).toEqual({
      status: 'queued',
      correlationId: 'corr-ack',
      lastSyncId: 0,
    });
    expect(commitAckSchema.safeParse({ status: 'queued', lastSyncId: 0 }).success).toBe(false);
  });
});
