export type BackfillStatus = 'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface BackfillCheckpoint {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly cursor: string | null;
  readonly processed: number;
  readonly batches: number;
  readonly status: BackfillStatus;
  readonly updatedAt: string;
  readonly error?: string;
}

export interface BackfillBatchResult {
  readonly nextCursor: string | null;
  readonly processed: number;
  readonly done: boolean;
}

export interface ResumableBackfillEffects {
  readonly load: (jobId: string) => Promise<BackfillCheckpoint | null>;
  readonly save: (checkpoint: BackfillCheckpoint) => Promise<void>;
  /** Must be idempotent for the job idempotency key and input cursor. */
  readonly runBatch: (input: { jobId: string; idempotencyKey: string; cursor: string | null; limit: number; signal?: AbortSignal }) => Promise<BackfillBatchResult>;
  readonly now?: () => string;
  readonly retry?: (error: unknown, attempt: number) => Promise<void>;
  /** Operational throttle checked before each batch; pause preserves the checkpoint for an exact resume. */
  readonly beforeBatch?: (checkpoint: BackfillCheckpoint) => Promise<'run' | 'pause'>;
  readonly onProgress?: (checkpoint: BackfillCheckpoint) => Promise<void> | void;
}

export interface ResumableBackfillOptions {
  readonly jobId: string;
  readonly idempotencyKey: string;
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
}

/** Bounded, resumable runner. A durable effect owns checkpoints; the transform owns idempotency. */
export async function runResumableBackfill(effects: ResumableBackfillEffects, options: ResumableBackfillOptions): Promise<BackfillCheckpoint> {
  if (!options.jobId || !options.idempotencyKey) throw new Error('backfill jobId and idempotencyKey are required');
  const batchSize = options.batchSize ?? 500;
  const maxBatches = options.maxBatches ?? 100;
  const maxAttempts = options.maxAttempts ?? 3;
  if (batchSize < 1 || maxBatches < 1 || maxAttempts < 1) throw new Error('backfill bounds must be positive');
  const now = effects.now ?? (() => new Date().toISOString());
  let checkpoint = await effects.load(options.jobId) ?? { jobId: options.jobId, idempotencyKey: options.idempotencyKey, cursor: null, processed: 0, batches: 0, status: 'pending' as const, updatedAt: now() };
  if (checkpoint.idempotencyKey !== options.idempotencyKey) throw new Error(`backfill job ${options.jobId} was created with a different idempotency key`);
  if (checkpoint.status === 'succeeded') return checkpoint;
  for (let batch = 0; batch < maxBatches; batch++) {
    if (options.signal?.aborted) {
      checkpoint = { ...checkpoint, status: 'cancelled', updatedAt: now() };
      await effects.save(checkpoint);
      return checkpoint;
    }
    if (await effects.beforeBatch?.(checkpoint) === 'pause') {
      checkpoint = { ...checkpoint, status: 'paused', updatedAt: now() };
      await effects.save(checkpoint);
      await effects.onProgress?.(checkpoint);
      return checkpoint;
    }
    let result: BackfillBatchResult | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        result = await effects.runBatch({ jobId: options.jobId, idempotencyKey: options.idempotencyKey, cursor: checkpoint.cursor, limit: batchSize, ...(options.signal ? { signal: options.signal } : {}) });
        break;
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) await effects.retry?.(error, attempt);
      }
    }
    if (!result) {
      checkpoint = { ...checkpoint, status: 'failed', updatedAt: now(), error: lastError instanceof Error ? lastError.message : String(lastError) };
      await effects.save(checkpoint);
      await effects.onProgress?.(checkpoint);
      return checkpoint;
    }
    if (!result.done && result.nextCursor === checkpoint.cursor) throw new Error(`backfill job ${options.jobId} did not advance its cursor`);
    checkpoint = { jobId: checkpoint.jobId, idempotencyKey: checkpoint.idempotencyKey, cursor: result.nextCursor, processed: checkpoint.processed + result.processed, batches: checkpoint.batches + 1, status: result.done ? 'succeeded' : 'running', updatedAt: now() };
    await effects.save(checkpoint);
    await effects.onProgress?.(checkpoint);
    if (result.done) return checkpoint;
  }
  return checkpoint;
}
