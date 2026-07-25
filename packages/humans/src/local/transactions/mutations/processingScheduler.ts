export interface ProcessingSchedulerContext {
  readonly processScheduled: boolean;
  readonly setProcessScheduled: (value: boolean) => void;
  readonly processTimer: ReturnType<typeof setTimeout> | undefined;
  readonly setProcessTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void;
  readonly executingCount: number;
  readonly maxExecutingTransactions: number;
  readonly batchDelay: number;
  readonly processBatch: () => void;
  readonly logger: { debug: (message: string, fields?: Record<string, number>) => void };
}

export function scheduleProcessing(ctx: ProcessingSchedulerContext, immediate = false): void {
  if (ctx.processScheduled) return;
  if (ctx.executingCount >= ctx.maxExecutingTransactions) {
    ctx.logger.debug('[MutationQueue] Backpressure: delaying batch, too many executing', {
      executingCount: ctx.executingCount, max: ctx.maxExecutingTransactions,
    });
    return;
  }
  ctx.setProcessScheduled(true);
  const run = () => {
    ctx.setProcessScheduled(false);
    ctx.processBatch();
  };
  if (immediate || ctx.batchDelay <= 0) {
    (typeof queueMicrotask === 'function' ? queueMicrotask : (callback: () => void) => Promise.resolve().then(callback))(run);
    return;
  }
  const timer = setTimeout(() => {
    ctx.setProcessTimer(undefined);
    run();
  }, Math.max(0, ctx.batchDelay));
  ctx.setProcessTimer(timer);
}
