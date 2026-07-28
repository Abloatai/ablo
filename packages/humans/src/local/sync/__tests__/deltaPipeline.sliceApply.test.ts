/**
 * `sliceApplyChanges` bounds how many deltas one apply slice reveals while
 * keeping the COMMIT the atomic unit of visibility: a transaction's changes
 * never split across slices, an oversized transaction forms its own slice
 * rather than stalling the pipeline, and order is preserved end to end.
 */

import { sliceApplyChanges } from '../deltaPipeline.js';

interface Change {
  readonly id: number;
  readonly transactionId?: string;
}

function change(id: number, transactionId?: string): Change {
  return transactionId === undefined ? { id } : { id, transactionId };
}

function txn(prefix: string, count: number, startId: number): Change[] {
  return Array.from({ length: count }, (_, i) => change(startId + i, prefix));
}

describe('sliceApplyChanges', () => {
  it('returns a batch under the bound as a single slice', () => {
    const changes = [...txn('a', 3, 0), ...txn('b', 2, 3)];
    expect(sliceApplyChanges(changes, 10)).toEqual([changes]);
  });

  it('returns no slices for an empty batch', () => {
    expect(sliceApplyChanges([], 10)).toEqual([]);
  });

  it('never splits a transaction across slices', () => {
    const changes = [...txn('a', 4, 0), ...txn('b', 4, 4), ...txn('c', 4, 8)];
    const slices = sliceApplyChanges(changes, 6);
    for (const slice of slices) {
      const transactions = new Set(slice.map((c) => c.transactionId));
      for (const transactionId of transactions) {
        const whole = changes.filter((c) => c.transactionId === transactionId);
        const inSlice = slice.filter((c) => c.transactionId === transactionId);
        expect(inSlice).toEqual(whole);
      }
    }
  });

  it('preserves order across slices', () => {
    const changes = [...txn('a', 5, 0), change(5), ...txn('b', 5, 6), change(11)];
    const slices = sliceApplyChanges(changes, 4);
    expect(slices.flat().map((c) => c.id)).toEqual(changes.map((c) => c.id));
  });

  it('gives an oversized transaction its own slice instead of stalling', () => {
    const big = txn('big', 20, 0);
    const changes = [...txn('a', 2, 100), ...big, ...txn('b', 2, 200)];
    const slices = sliceApplyChanges(changes, 5);
    const bigSlice = slices.find((slice) => slice.some((c) => c.transactionId === 'big'));
    expect(bigSlice).toEqual(big);
  });

  it('splits untransacted changes freely at the bound', () => {
    const changes = Array.from({ length: 10 }, (_, i) => change(i));
    const slices = sliceApplyChanges(changes, 4);
    expect(slices.map((slice) => slice.length)).toEqual([4, 4, 2]);
  });

  it('packs consecutive transactions up to the bound', () => {
    const changes = [...txn('a', 3, 0), ...txn('b', 3, 3), ...txn('c', 3, 6)];
    const slices = sliceApplyChanges(changes, 6);
    expect(slices.map((slice) => slice.length)).toEqual([6, 3]);
  });
});
