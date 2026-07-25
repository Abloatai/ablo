import type { RuntimeContext } from '../RuntimeContext.js';
import type { SyncStatus } from '../storeContract.js';

export interface TerminalSessionLifecycleContext {
  readonly runtime: RuntimeContext;
  readonly listeners: Set<(error: Error) => void>;
  purgeAuthenticatedState(): Promise<void>;
  updateSyncStatus(updates: Partial<SyncStatus>): void;
}

/**
 * Owns the one-way authenticated -> terminal transition. Cleanup is
 * single-flight and listeners run only after the local boundary has settled.
 */
export class TerminalSessionLifecycle {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly context: TerminalSessionLifecycleContext) {}

  start(error: Error): void {
    if (this.inFlight) return;
    this.context.runtime.observability.captureWebSocketError({
      context: 'session-error',
      error: error.message,
    });
    this.context.updateSyncStatus({
      state: 'error',
      error,
      isSessionError: true,
    });
    this.inFlight = this.run(error);
  }

  settled(): Promise<void> | null {
    return this.inFlight;
  }

  private async run(sessionError: Error): Promise<void> {
    let reportedError = sessionError;
    try {
      await this.context.purgeAuthenticatedState();
    } catch (cleanupError) {
      this.context.runtime.logger.error(
        'Your session ended, but authenticated local data could not be completely removed.',
      );
      this.context.runtime.logger.debug(
        '[TerminalSessionLifecycle] Local cleanup failed',
        cleanupError,
      );
      reportedError =
        cleanupError instanceof Error
          ? cleanupError
          : new Error(String(cleanupError));
    }
    for (const listener of this.context.listeners) {
      try {
        listener(reportedError);
      } catch (listenerError) {
        this.context.runtime.logger.debug(
          '[TerminalSessionLifecycle] Session-error listener failed',
          listenerError,
        );
      }
    }
  }
}
