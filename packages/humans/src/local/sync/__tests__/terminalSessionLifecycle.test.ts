import { TerminalSessionLifecycle } from '../terminalSessionLifecycle.js';
import { globalRuntime as runtime } from '../../context.js';

describe('TerminalSessionLifecycle', () => {
  let loggerError: jest.SpiedFunction<typeof runtime.logger.error>;

  beforeEach(() => {
    loggerError = jest.spyOn(runtime.logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(runtime.logger, 'debug').mockImplementation(() => undefined);
    jest
      .spyOn(runtime.observability, 'captureWebSocketError')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is single-flight and notifies only after cleanup', async () => {
    let release!: () => void;
    const purge = jest.fn(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const listener = jest.fn();
    const lifecycle = new TerminalSessionLifecycle({
      runtime,
      listeners: new Set([listener]),
      purgeAuthenticatedState: purge,
      updateSyncStatus: jest.fn(),
    });
    const error = new Error('expired');

    lifecycle.start(error);
    lifecycle.start(error);
    expect(purge).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    release();
    await lifecycle.settled();
    expect(listener).toHaveBeenCalledWith(error);
  });

  it('surfaces cleanup failure to listeners', async () => {
    const cleanupError = Object.assign(new Error('blocked'), {
      code: 'db_cleanup_failed',
    });
    const listener = jest.fn();
    const lifecycle = new TerminalSessionLifecycle({
      runtime,
      listeners: new Set([listener]),
      purgeAuthenticatedState: () => Promise.reject(cleanupError),
      updateSyncStatus: jest.fn(),
    });

    lifecycle.start(new Error('expired'));
    await lifecycle.settled();

    expect(listener).toHaveBeenCalledWith(cleanupError);
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
