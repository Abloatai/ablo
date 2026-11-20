import { describe, expect, it } from '@jest/globals';
import {
  isSubscriptionEntitled,
  selectPlanForConnectionCapacity,
  SUBSCRIPTION_ENTITLEMENT,
} from '../pricing.js';

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

describe('isSubscriptionEntitled', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it.each(['active', 'trialing', 'past_due'])('keeps the plan while %s, however long', (status) => {
    expect(isSubscriptionEntitled(status, daysAgo(400), now)).toBe(true);
    expect(isSubscriptionEntitled(status, null, now)).toBe(true);
  });

  it('keeps the plan for the unpaid grace window, then drops it', () => {
    const grace = SUBSCRIPTION_ENTITLEMENT.graceDays;
    expect(isSubscriptionEntitled('unpaid', daysAgo(grace - 1), now)).toBe(true);
    expect(isSubscriptionEntitled('unpaid', daysAgo(grace), now)).toBe(false);
    expect(isSubscriptionEntitled('unpaid', null, now)).toBe(false);
  });

  it.each(['canceled', 'incomplete', 'incomplete_expired', 'paused', 'not_a_status'])(
    'grants nothing when %s',
    (status) => {
      expect(isSubscriptionEntitled(status, now, now)).toBe(false);
    },
  );
});
