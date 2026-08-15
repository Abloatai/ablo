import { describe, expect, it } from 'vitest';

import {
  analyticsDigestsEqual,
  digestAnalyticsIdentifier,
  findProhibitedAnalyticsPropertyKey,
} from '../src/privacy';

const key = 'analytics-hmac-key-with-at-least-thirty-two-bytes';

describe('analytics privacy helpers', () => {
  it('creates a deterministic keyed digest without retaining the identifier', () => {
    const input = '0198a785-77d3-7397-aa80-3a69fa9a895a';
    const first = digestAnalyticsIdentifier({ identifier: input, key, keyVersion: 2 });
    const second = digestAnalyticsIdentifier({ identifier: input, key, keyVersion: 2 });

    expect(first).toEqual(second);
    expect(first.keyVersion).toBe(2);
    expect(first.digest).not.toContain(input);
    expect(analyticsDigestsEqual(first.digest, second.digest)).toBe(true);
  });

  it('changes the digest when the key rotates', () => {
    const identifier = '0198a785-77d3-7397-aa80-3a69fa9a895a';
    const previous = digestAnalyticsIdentifier({ identifier, key, keyVersion: 1 });
    const current = digestAnalyticsIdentifier({
      identifier,
      key: `${key}-rotated`,
      keyVersion: 2,
    });

    expect(analyticsDigestsEqual(previous.digest, current.digest)).toBe(false);
  });

  it.each([
    'path',
    'schema',
    'modelName',
    'email',
    'token',
    'rawError',
    'payload',
    'prompt',
    'sourceCode',
  ])('detects prohibited nested property %s', (property) => {
    expect(findProhibitedAnalyticsPropertyKey({ safe: { [property]: 'secret' } })).toBe(property);
  });
});
