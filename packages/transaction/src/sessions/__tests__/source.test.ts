import { describe, expect, it, jest } from '@jest/globals';
import {
  createSessionAccess,
  resolveSessionCredential,
} from '../source.js';
import type { SessionCredential } from '../contract.js';

const SESSION: SessionCredential = {
  object: 'session',
  token: 'rk_agent_session',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

describe('session source', () => {
  it('normalizes static and renewable inputs before transport construction', async () => {
    const credential = jest.fn(async () => SESSION);

    const staticAccess = createSessionAccess(SESSION, credential);
    const providerAccess = createSessionAccess(async () => SESSION, credential);
    const endpointAccess = createSessionAccess({ endpoint: '/api/ablo-session' }, credential);

    expect(staticAccess.renewable).toBe(false);
    expect(providerAccess.renewable).toBe(true);
    expect(endpointAccess.renewable).toBe(true);
    await expect(providerAccess.credential()).resolves.toBe(SESSION);
  });

  it('shares one provider mint while the current session remains usable', async () => {
    const provider = jest.fn(async () => SESSION);
    const credential = resolveSessionCredential(provider, {});
    expect(typeof credential).toBe('function');
    if (typeof credential !== 'function') throw new Error('expected provider');

    const [first, second] = await Promise.all([credential(), credential()]);

    expect(first).toBe(SESSION);
    expect(second).toBe(SESSION);
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
