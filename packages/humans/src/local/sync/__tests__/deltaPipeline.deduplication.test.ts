import { deduplicateDeltas } from '../deltaPipeline.js';
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

describe('delta pipeline deduplication', () => {
  it('returns an already ordered frame without rebuilding it', () => {
    const frame = [delta(1, 'a'), delta(2, 'b'), delta(3, 'c')];
    expect(deduplicateDeltas(frame)).toBe(frame);
  });

  it('keeps every ordered change when an entity repeats', () => {
    const frame = [delta(1, 'a'), delta(2, 'a'), delta(3, 'a', 'D')];
    expect(deduplicateDeltas(frame)).toBe(frame);
  });

  it('orders overlap and removes only a repeated sync id', () => {
    const frame = [delta(3, 'a'), delta(1, 'a'), delta(2, 'b'), delta(3, 'a')];
    expect(deduplicateDeltas(frame).map(({ id }) => id)).toEqual([1, 2, 3]);
  });
});
