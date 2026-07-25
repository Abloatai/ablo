/**
 * The shared safe-DDL knob reader — consumed by BOTH `ablo migrate` (CLI) and
 * the hosted executor (apps/sync-server ddlExec.ts). Pins the drift this leaf
 * fixes: the server honored `ABLO_SCHEMA_LOCK_ATTEMPTS` while the CLI
 * hardcoded 5 attempts, so tuning the knob applied to hosted push but was
 * silently ignored by `ablo migrate`.
 */
import {
  PG_LOCK_NOT_AVAILABLE,
  resolveDdlLockTimeout,
  resolveDdlMaxLockAttempts,
  ddlLockRetryBackoffMs,
} from '../ddlLock.js';

describe('ddlLock — shared safe-DDL locking knobs', () => {
  it('PG_LOCK_NOT_AVAILABLE is the Postgres lock_not_available SQLSTATE', () => {
    expect(PG_LOCK_NOT_AVAILABLE).toBe('55P03');
  });

  describe('resolveDdlLockTimeout', () => {
    it('defaults to a low 5s', () => {
      expect(resolveDdlLockTimeout({})).toBe('5s');
    });

    it('honors ABLO_SCHEMA_LOCK_TIMEOUT, then the legacy ABLO_DDL name', () => {
      expect(
        resolveDdlLockTimeout({ ABLO_SCHEMA_LOCK_TIMEOUT: '2s', ABLO_DDL_LOCK_TIMEOUT: '9s' }),
      ).toBe('2s');
      expect(resolveDdlLockTimeout({ ABLO_DDL_LOCK_TIMEOUT: '9s' })).toBe('9s');
    });
  });

  describe('resolveDdlMaxLockAttempts (the knob that had drifted between CLI and server)', () => {
    it('defaults to 5', () => {
      expect(resolveDdlMaxLockAttempts({})).toBe(5);
    });

    it('honors ABLO_SCHEMA_LOCK_ATTEMPTS, then the legacy ABLO_DDL name', () => {
      expect(
        resolveDdlMaxLockAttempts({ ABLO_SCHEMA_LOCK_ATTEMPTS: '8', ABLO_DDL_LOCK_ATTEMPTS: '3' }),
      ).toBe(8);
      expect(resolveDdlMaxLockAttempts({ ABLO_DDL_LOCK_ATTEMPTS: '3' })).toBe(3);
    });

    it('never disables the retry loop: floors at 1, and a malformed value falls back to the default', () => {
      expect(resolveDdlMaxLockAttempts({ ABLO_SCHEMA_LOCK_ATTEMPTS: '0' })).toBe(1);
      expect(resolveDdlMaxLockAttempts({ ABLO_SCHEMA_LOCK_ATTEMPTS: '-2' })).toBe(1);
      expect(resolveDdlMaxLockAttempts({ ABLO_SCHEMA_LOCK_ATTEMPTS: 'lots' })).toBe(5);
      expect(resolveDdlMaxLockAttempts({ ABLO_SCHEMA_LOCK_ATTEMPTS: '2.9' })).toBe(2);
    });

    it('reads process.env at CALL time by default (an operator export applies to the next run)', () => {
      const prev = process.env.ABLO_SCHEMA_LOCK_ATTEMPTS;
      process.env.ABLO_SCHEMA_LOCK_ATTEMPTS = '7';
      try {
        expect(resolveDdlMaxLockAttempts()).toBe(7);
      } finally {
        if (prev === undefined) delete process.env.ABLO_SCHEMA_LOCK_ATTEMPTS;
        else process.env.ABLO_SCHEMA_LOCK_ATTEMPTS = prev;
      }
    });
  });

  describe('ddlLockRetryBackoffMs', () => {
    it('grows exponentially and caps at 60s, plus up to 50ms jitter', () => {
      const first = ddlLockRetryBackoffMs(1);
      expect(first).toBeGreaterThanOrEqual(20);
      expect(first).toBeLessThan(20 + 50);

      const capped = ddlLockRetryBackoffMs(30);
      expect(capped).toBeGreaterThanOrEqual(60_000);
      expect(capped).toBeLessThan(60_050);
    });
  });
});
