import { describe, expect, it } from '@jest/globals';
import { selectPlanForConnectionCapacity } from '../pricing.js';

describe('selectPlanForConnectionCapacity', () => {
  it.each([
    [1, 'free'],
    [25, 'free'],
    [26, 'scale'],
    [5_000, 'scale'],
    [5_001, 'enterprise'],
    [100_000, 'enterprise'],
  ] as const)('routes %s concurrent connections to %s', (connections, tier) => {
    expect(selectPlanForConnectionCapacity(connections)).toBe(tier);
  });

  it('normalizes unusable calculator input to the smallest reservation', () => {
    expect(selectPlanForConnectionCapacity(0)).toBe('free');
    expect(selectPlanForConnectionCapacity(Number.NaN)).toBe('free');
  });
});
