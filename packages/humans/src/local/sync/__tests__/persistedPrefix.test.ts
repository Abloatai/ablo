import { highestPersistedPrefixSyncId } from '../persistedPrefix.js';

describe('highestPersistedPrefixSyncId', () => {
  const deltas = [
    { syncId: 100 },
    { syncId: '102' },
    { syncId: 105 },
  ] as const;

  it('advances through every input when every store transaction persisted', () => {
    expect(highestPersistedPrefixSyncId(deltas, new Set([0, 1, 2]))).toBe(105);
  });

  it('stops before an earlier failure even when a later store persisted', () => {
    expect(highestPersistedPrefixSyncId(deltas, new Set([1, 2]))).toBe(0);
    expect(highestPersistedPrefixSyncId(deltas, new Set([0, 2]))).toBe(100);
  });

  it('allows numeric gaps because filtered streams are not globally contiguous', () => {
    expect(highestPersistedPrefixSyncId(deltas, new Set([0, 1]))).toBe(102);
  });
});
