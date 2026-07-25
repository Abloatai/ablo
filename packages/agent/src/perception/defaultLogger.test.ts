/**
 * Agent default-logger gating (doctor T1.26).
 *
 * The agent runtime used to ship a hand-rolled console shim that ignored
 * `ABLO_LOG_LEVEL` entirely — printing `[perception]` engine internals at
 * debug/info for every standalone worker. The default logger now reuses the
 * SDK's gated `createConsoleLogger(resolveLogLevel())` (threshold `warn` by
 * default), tagged `[agent]`.
 *
 * NOTE: the consumer-log-register guard test scans `logger.warn/error(`
 * string literals only — a console-BACKED default logger like this one is
 * structurally outside its reach, which is why the gating is pinned here
 * behaviorally instead.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { defaultAgentLogger } from './Agent.js';

const ORIGINAL_LEVEL = process.env.ABLO_LOG_LEVEL;

afterEach(() => {
  if (ORIGINAL_LEVEL === undefined) delete process.env.ABLO_LOG_LEVEL;
  else process.env.ABLO_LOG_LEVEL = ORIGINAL_LEVEL;
  vi.restoreAllMocks();
});

describe('defaultAgentLogger — ABLO_LOG_LEVEL gating', () => {
  it('drops debug/info by default (threshold warn) but emits warn/error', () => {
    delete process.env.ABLO_LOG_LEVEL;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const logger = defaultAgentLogger();
    logger.debug('[perception] announcer error', { detail: true });
    logger.info('[perception] gathered context');
    logger.warn('claim expired');
    logger.error('announce failed');

    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('keeps the [agent] tag under the SDK [Ablo] namespace on emitted lines', () => {
    delete process.env.ABLO_LOG_LEVEL;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    defaultAgentLogger().warn('claim expired', { id: 'c1' });

    expect(warn).toHaveBeenCalledWith('[Ablo]', '[agent]', 'claim expired', { id: 'c1' });
  });

  it('honors ABLO_LOG_LEVEL=debug set before construction', () => {
    process.env.ABLO_LOG_LEVEL = 'debug';
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    defaultAgentLogger().debug('[perception] verbose internals');

    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('honors ABLO_LOG_LEVEL=silent (even error is dropped)', () => {
    process.env.ABLO_LOG_LEVEL = 'silent';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    defaultAgentLogger().error('announce failed');

    expect(error).not.toHaveBeenCalled();
  });
});
