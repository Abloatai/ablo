/**
 * CredentialLifecycle.recoverFromAuthRejection — THE auth-recovery backbone
 * for HTTP transports. One single-flight mint, one FSM outcome routing,
 * driven by the closed recovery taxonomy:
 *
 *   access_credential_expiry → silent re-mint; 'retry' on success (+ nudge),
 *                              reportSessionExpired ONLY if the mint resolves
 *                              null, 'stop' on a transient mint failure.
 *   session_expiry           → reportSessionExpired + 'stop' (no mint).
 *   auth_blocked/permission/… → 'stop' untouched (re-minting reproduces the
 *                              same rejected credential).
 */

import {
  CredentialLifecycle,
  type CredentialLifecycleContext,
} from '../../src/local/sync/credentialLifecycle';

interface ContextSpies {
  ctx: CredentialLifecycleContext;
  setAuthToken: jest.Mock;
  nudgeReconnect: jest.Mock;
  reportSessionExpired: jest.Mock;
}

function makeContext(): ContextSpies {
  const setAuthToken = jest.fn();
  const nudgeReconnect = jest.fn();
  const reportSessionExpired = jest.fn();
  return {
    ctx: { setAuthToken, nudgeReconnect, reportSessionExpired },
    setAuthToken,
    nudgeReconnect,
    reportSessionExpired,
  };
}

describe('CredentialLifecycle.recoverFromAuthRejection', () => {
  it('access_credential_expiry + successful mint → retry, fresh token pushed, connection nudged', async () => {
    const { ctx, setAuthToken, nudgeReconnect, reportSessionExpired } = makeContext();
    const lifecycle = new CredentialLifecycle(ctx);
    lifecycle.setRefresher(() => Promise.resolve('ek_fresh'));

    await expect(lifecycle.recoverFromAuthRejection('access_credential_expiry')).resolves.toBe(
      'retry',
    );
    expect(setAuthToken).toHaveBeenCalledWith('ek_fresh');
    expect(nudgeReconnect).toHaveBeenCalledTimes(1);
    expect(reportSessionExpired).not.toHaveBeenCalled();
  });

  it('access_credential_expiry + mint resolves null (login gone) → stop + reportSessionExpired', async () => {
    const { ctx, setAuthToken, reportSessionExpired } = makeContext();
    const lifecycle = new CredentialLifecycle(ctx);
    lifecycle.setRefresher(() => Promise.resolve(null));

    await expect(lifecycle.recoverFromAuthRejection('access_credential_expiry')).resolves.toBe(
      'stop',
    );
    expect(reportSessionExpired).toHaveBeenCalledTimes(1);
    expect(setAuthToken).not.toHaveBeenCalled();
  });

  it('access_credential_expiry + mint throws (transient/offline) → stop, NO sign-out', async () => {
    const { ctx, reportSessionExpired, nudgeReconnect } = makeContext();
    const lifecycle = new CredentialLifecycle(ctx);
    lifecycle.setRefresher(() => Promise.reject(new Error('mint endpoint unreachable')));

    await expect(lifecycle.recoverFromAuthRejection('access_credential_expiry')).resolves.toBe(
      'stop',
    );
    expect(reportSessionExpired).not.toHaveBeenCalled();
    expect(nudgeReconnect).not.toHaveBeenCalled();
  });

  it('session_expiry → stop + reportSessionExpired WITHOUT attempting a mint', async () => {
    const { ctx, reportSessionExpired } = makeContext();
    const lifecycle = new CredentialLifecycle(ctx);
    const refresher = jest.fn(() => Promise.resolve('ek_should_not_mint'));
    lifecycle.setRefresher(refresher);

    await expect(lifecycle.recoverFromAuthRejection('session_expiry')).resolves.toBe('stop');
    expect(reportSessionExpired).toHaveBeenCalledTimes(1);
    expect(refresher).not.toHaveBeenCalled();
  });

  it.each(['auth_blocked', 'permission', 'transient', 'none'] as const)(
    '%s → stop untouched (no mint, no FSM events)',
    async (recovery) => {
      const { ctx, reportSessionExpired, nudgeReconnect } = makeContext();
      const lifecycle = new CredentialLifecycle(ctx);
      const refresher = jest.fn(() => Promise.resolve('ek_should_not_mint'));
      lifecycle.setRefresher(refresher);

      await expect(lifecycle.recoverFromAuthRejection(recovery)).resolves.toBe('stop');
      expect(refresher).not.toHaveBeenCalled();
      expect(reportSessionExpired).not.toHaveBeenCalled();
      expect(nudgeReconnect).not.toHaveBeenCalled();
    },
  );

  it('no refresher wired (static apiKey deployment) → retry as a no-op re-probe', async () => {
    // Mirrors `refresh()`'s contract: a static-key deployment refreshes its
    // credential source out-of-band, so recovery just re-probes/replays with
    // whatever the source currently holds.
    const { ctx, nudgeReconnect } = makeContext();
    const lifecycle = new CredentialLifecycle(ctx);

    await expect(lifecycle.recoverFromAuthRejection('access_credential_expiry')).resolves.toBe(
      'retry',
    );
    expect(nudgeReconnect).toHaveBeenCalledTimes(1);
  });

  it('concurrent recoveries share ONE mint (single-flight)', async () => {
    const { ctx } = makeContext();
    const lifecycle = new CredentialLifecycle(ctx);
    let mints = 0;
    lifecycle.setRefresher(async () => {
      mints++;
      await new Promise((r) => setTimeout(r, 10));
      return 'ek_fresh';
    });

    const outcomes = await Promise.all([
      lifecycle.recoverFromAuthRejection('access_credential_expiry'),
      lifecycle.recoverFromAuthRejection('access_credential_expiry'),
      lifecycle.recoverFromAuthRejection('access_credential_expiry'),
    ]);
    expect(outcomes).toEqual(['retry', 'retry', 'retry']);
    expect(mints).toBe(1);
  });
});
