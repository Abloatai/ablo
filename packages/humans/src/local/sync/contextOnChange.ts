import type { ReadDependency } from '@abloatai/transaction/coordination';
import { AbloStaleContextError } from '@abloatai/transaction/errors';
import type { InstanceCache } from '../InstanceCache.js';
import type { SyncDelta } from './SyncWebSocket.js';

export interface ContextOnChangeTransport {
  subscribe(event: string, listener: (value?: unknown) => void): () => void;
}

/** Match context reads on the reactive client's existing delta connection. */
export function contextOnChange(
  transport: ContextOnChangeTransport,
  pool: Pick<InstanceCache, 'peek' | 'watermarks'>,
  reads: readonly ReadDependency[],
  listener: (error: AbloStaleContextError) => void,
): () => void {
  let stopped = false;
  const rowReads = reads.filter(
    (read): read is Extract<ReadDependency, { model: string }> => 'model' in read,
  );

  const stopDelta = transport.subscribe('delta', (value) => {
    if (isDelta(value)) changedBy([value]);
  });
  const stopBatch = transport.subscribe('delta_batch', (value) => {
    if (Array.isArray(value)) changedBy(value.filter(isDelta));
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    stopDelta();
    stopBatch();
  }

  function changedBy(deltas: readonly SyncDelta[]): void {
    if (stopped) return;
    for (const delta of deltas) {
      const read = rowReads.find(
        (candidate) =>
          candidate.model.toLowerCase() === delta.modelName.toLowerCase() &&
          candidate.id === delta.modelId &&
          delta.id > candidate.readAt,
      );
      if (!read) continue;
      stop();
      listener(staleError(read.model, read.id, read.readAt, delta.id));
      return;
    }
  }

  // Subscribe first, then inspect the resident row. A delta that lands between
  // the original read and this attachment is either observed above or has
  // already advanced this exact row in the pool.
  for (const read of rowReads) {
    const resident = pool.peek(read.id);
    if (!resident || resident.getModelName().toLowerCase() !== read.model.toLowerCase()) {
      continue;
    }
    const observed = pool.watermarks.of(resident);
    if (observed !== undefined && observed > read.readAt) {
      stop();
      listener(staleError(read.model, read.id, read.readAt, observed));
      break;
    }
  }

  return stop;
}

function staleError(
  model: string,
  id: string,
  readAt: number,
  observedSyncId: number,
): AbloStaleContextError {
  return new AbloStaleContextError('Context changed after read.', {
    code: 'stale_context',
    readAt,
    conflicts: [{ model, id, observedSyncId }],
  });
}

function isDelta(value: unknown): value is SyncDelta {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'number' &&
    typeof (value as { modelName?: unknown }).modelName === 'string' &&
    typeof (value as { modelId?: unknown }).modelId === 'string'
  );
}
