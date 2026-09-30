import { InstanceCache } from '../../src/local/InstanceCache';
import { ModelRegistry, setActiveRegistry } from '../../src/local/ModelRegistry';
import { createTestContext, registerTestModels, TestItem } from '../../src/local/testing';

describe('ObjectPool tracking expiry', () => {
  let pool: InstanceCache;
  let cleanup: () => void;
  let now: number;
  // Bracket access preserves the private members' inferred types in this test.
  /* eslint-disable @typescript-eslint/dot-notation */
  const tracking = () => ({
    recentAdditions: pool['recentAdditions'],
    cleanupTracking: () => { pool['cleanupTracking'](); },
    gc: () => pool['gc'](),
  });
  /* eslint-enable @typescript-eslint/dot-notation */
  const add = (id: string, syncId = 0) => {
    const model = new TestItem({ id, title: id });
    pool.add(model, undefined, { syncId, action: 'I' });
    return model;
  };

  beforeEach(() => {
    const registry = new ModelRegistry();
    setActiveRegistry(registry);
    registerTestModels(registry);
    cleanup = createTestContext().cleanup;
    pool = new InstanceCache({ maxSize: 10000, gcInterval: 0, useWeakRefs: false }, registry);
    now = 10000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => { pool.clear(); cleanup(); jest.restoreAllMocks(); });

  it('avoids scanning a fresh burst and retains the exact one-second boundary', () => {
    const scan = jest.spyOn(tracking().recentAdditions, Symbol.iterator);
    for (let i = 0; i < 150; i++) add(`row-${i}`);
    expect(scan).not.toHaveBeenCalled();
    now = 11000;
    add('at-boundary');
    expect(tracking().recentAdditions.size).toBe(151);
    expect(scan).not.toHaveBeenCalled();
    now = 11001;
    add('after-boundary');
    expect(scan).toHaveBeenCalledTimes(1);
    expect([...tracking().recentAdditions.values()]).toEqual([11000, 11001]);
  });

  it('keeps rapid-add and sync-history deduplication after expiry', () => {
    const first = add('same', 10);
    first.dispose();
    now += 49;
    add('same', 11);
    expect(pool.getStats().metrics.duplicatesSkipped).toBe(1);
    now += 1;
    const newer = add('same', 11);
    expect(pool.get('same')).toBe(newer);
    newer.dispose();
    now = 12000;
    tracking().cleanupTracking();
    add('same', 11);
    expect(pool.getStats().metrics.duplicatesSkipped).toBe(2);
    expect(pool.get('same')).toBeUndefined();
    pool.remove('same');
    expect(pool.get('same')).toBeUndefined();
    expect(add('same', 1)).toBe(pool.get('same'));
  });

  it('handles backward clocks and stale minima after removal and refresh', () => {
    const first = add('first');
    first.dispose();
    now = 10050;
    add('first'); // Refresh leaves a conservative old minimum.
    now = 9000;
    add('backward');
    now = 10000;
    tracking().cleanupTracking();
    expect(tracking().recentAdditions.size).toBe(2);
    now = 10001;
    tracking().cleanupTracking();
    expect(tracking().recentAdditions.size).toBe(1);
    pool.removeBatch(['first']);
    now = 13000;
    tracking().cleanupTracking();
    expect(tracking().recentAdditions.size).toBe(0);
  });

  it('resets tracking on clear and still expires it through GC', () => {
    add('old');
    pool.clear();
    now = 20000;
    const scan = jest.spyOn(tracking().recentAdditions, Symbol.iterator);
    for (let i = 0; i < 150; i++) add(`new-${i}`);
    expect(scan).not.toHaveBeenCalled();
    now += 1001;
    tracking().gc();
    expect(tracking().recentAdditions.size).toBe(0);
    expect(pool.get('new-0')).toBeDefined();
  });

  it('clears tracking while preserving observed models', () => {
    const observed = add('observed');
    jest.spyOn(observed, 'hasObservedCollections').mockReturnValue(true);
    pool.clear({ preserveObserved: true });
    expect(pool.get('observed')).toBe(observed);
    expect(tracking().recentAdditions.size).toBe(0);
    now = 20000;
    const scan = jest.spyOn(tracking().recentAdditions, Symbol.iterator);
    for (let i = 0; i < 150; i++) add(`after-clear-${i}`);
    expect(scan).not.toHaveBeenCalled();
  });
});
