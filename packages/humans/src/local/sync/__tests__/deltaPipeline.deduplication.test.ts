import { deduplicateDeltas, type DeltaPipelineContext } from '../deltaPipeline.js';
import type { SyncDelta } from '../SyncWebSocket.js';

function delta(id: number, modelId: string, actionType: SyncDelta['actionType'] = 'I'): SyncDelta {
  return {
    id,
    actionType,
    modelName: 'Item',
    modelId,
    data: { id: modelId, status: String(id) },
    syncGroups: [],
    createdAt: new Date(id).toISOString(),
  };
}

const context = {
  getStateFields: () => ['status'],
} as DeltaPipelineContext;

describe('delta pipeline deduplication', () => {
  it('returns an already ordered unique-entity frame without rebuilding it', () => {
    const frame = [delta(1, 'a'), delta(2, 'b'), delta(3, 'c')];
    expect(deduplicateDeltas(context, frame)).toBe(frame);
  });

  it('retains the full reconciliation path when an entity repeats', () => {
    const frame = [delta(3, 'a'), delta(1, 'a'), delta(2, 'b'), delta(4, 'a', 'D')];
    expect(deduplicateDeltas(context, frame).map(({ id }) => id)).toEqual([2, 4]);
  });
});
