import { BootstrapResponseSchema, ServerDeltaSchema } from '../schemas.js';

describe('ServerDeltaSchema', () => {
  it('accepts the delta shape the server actually sends', () => {
    // The bootstrap route returns `ServerSyncDelta` rows straight from the
    // adapter (apps/sync-server/src/storage/bootstrap.ts), and that shape is
    // `serverSyncDeltaSchema` in @abloatai/transaction/wire/delta — `actionType`
    // and `modelId`. Every other case in this file feeds a spelling no
    // producer emits, so this is the one that pins the decoder to its source.
    const fromTheServer = {
      id: 42,
      actionType: 'U',
      modelName: 'Item',
      modelId: 'item_1',
      data: { title: 'renamed' },
      syncGroups: ['org:org_1'],
      createdAt: '2026-07-21T00:00:00.000Z',
    };

    expect(ServerDeltaSchema.safeParse(fromTheServer).success).toBe(true);
  });

  it('keeps a delete delta, whose data is null', () => {
    expect(
      ServerDeltaSchema.parse({
        id: 10,
        actionType: 'D',
        modelName: 'Item',
        modelId: 'item_1',
        data: null,
      }),
    ).toMatchObject({
      id: 10,
      actionType: 'D',
      modelName: 'Item',
      modelId: 'item_1',
      data: null,
    });
  });

  it('keeps the server-only fields it does not read, for later stages', () => {
    const parsed = ServerDeltaSchema.parse({
      id: 11,
      actionType: 'I',
      modelName: 'Item',
      modelId: 'item_2',
      data: { title: 'new' },
      workspaceId: 'proj_1',
      actor: { kind: 'user', id: 'u1' },
    });

    expect(parsed).toMatchObject({ workspaceId: 'proj_1', actor: { kind: 'user', id: 'u1' } });
  });

  it('refuses a delta missing the fields the applier reads', () => {
    // Each of these would otherwise reach `processDeltaBatch` as `undefined`
    // and apply a delta to no row, or to the wrong one.
    for (const missing of ['actionType', 'modelName', 'modelId'] as const) {
      const complete: Record<string, unknown> = {
        id: 12,
        actionType: 'U',
        modelName: 'Item',
        modelId: 'item_3',
        data: null,
      };
      // Built without the field rather than mutated to drop it, so `complete`
      // stays the one statement of what a whole delta looks like.
      const incomplete = Object.fromEntries(
        Object.entries(complete).filter(([field]) => field !== missing),
      );
      expect(ServerDeltaSchema.safeParse(incomplete).success).toBe(false);
    }

    // `M` was removed from the action vocabulary; it must not slip back in.
    expect(
      ServerDeltaSchema.safeParse({
        id: 12,
        actionType: 'M',
        modelName: 'Item',
        modelId: 'item_3',
        data: null,
      }).success,
    ).toBe(false);
  });
});

describe('BootstrapResponseSchema', () => {
  it('parses a partial bootstrap carrying the deltas the server sends', () => {
    const parsed = BootstrapResponseSchema.parse({
      type: 'partial',
      lastSyncId: 20,
      deltas: [
        {
          id: 20,
          actionType: 'V',
          modelName: 'Item',
          modelId: 'item_4',
          data: null,
        },
      ],
    });

    expect(parsed.deltas?.[0]).toMatchObject({
      actionType: 'V',
      modelId: 'item_4',
      data: null,
    });
  });
});
