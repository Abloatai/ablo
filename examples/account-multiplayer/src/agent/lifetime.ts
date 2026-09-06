export type RunStatus = 'acquiring' | 'executing' | 'skipped' | 'completed' | 'stopped' | 'failed';

/** One process-owned run. Every exit shares one cleanup promise. */
export function startOwnedRun<Claim extends { release(): Promise<unknown> }>(options: {
  acquire(onLost: (error: Error) => void): Promise<Claim | null>;
  execute(claim: Claim, signal: AbortSignal): Promise<void>;
  dispose(): Promise<unknown>;
}) {
  const controller = new AbortController();
  let claim: Claim | null = null;
  let status: RunStatus = 'acquiring';
  let executions = 0;
  let outcome: RunStatus = 'failed';
  let cleanup: Promise<void> | undefined;
  function cleanUp() {
    return cleanup ??= (async () => {
      try { await claim?.release(); }
      finally { await options.dispose(); }
    })();
  }
  const done = (async () => {
    try {
      claim = await options.acquire((error) => controller.abort(error));
      if (!claim) { outcome = 'skipped'; return; }
      if (controller.signal.aborted) { outcome = 'stopped'; return; }
      status = 'executing';
      executions++;
      await options.execute(claim, controller.signal);
      outcome = controller.signal.aborted ? 'stopped' : 'completed';
    } finally {
      try { await cleanUp(); }
      catch (error) { outcome = 'failed'; throw error; }
      finally { status = outcome; }
    }
  })();
  return {
    done,
    get status() { return status; },
    get executions() { return executions; },
    stop() {
      controller.abort(new Error('Agent stopping'));
      // Wait for acquisition/execution to settle before releasing the claim.
      // The execution callback must cooperate with cancellation.
      return done;
    },
  };
}
