/**
 * Human-side reconnect adapter.
 *
 * The confirmation callback owns ordering and receipts. This adapter owns the
 * local client's reconnect concurrency: repeated online/connect signals join
 * the same drain instead of starting competing local recovery passes.
 */
export interface ReconnectDrain {
  drain(run: () => Promise<void>): Promise<void>;
}

export function createReconnectDrain(): ReconnectDrain {
  let inFlight: Promise<void> | null = null;

  return {
    drain(run) {
      if (inFlight) return inFlight;
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
