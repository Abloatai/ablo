import { AbloConnectionError, AbloError, translateHttpError } from '../../errors.js';
import {
  MODEL_READ_BATCH_SIZE,
  MODEL_READ_BATCH_MAX_BYTES,
  type ModelReadBatchItem,
  type ModelReadBatchResponse,
  type ModelReadResponse,
  type ModelListResponse,
} from '../../wire/modelResponses.js';

type ReadResult = ModelReadResponse | ModelListResponse;
type PendingRead = {
  readonly item: ModelReadBatchItem;
  readonly resolve: (result: ReadResult) => void;
  readonly reject: (error: unknown) => void;
};

/** Same-turn reads share one request; nothing is cached across dispatches. */
export function createHttpReadBatch(options: {
  readonly send: (reads: ModelReadBatchItem[]) => Promise<ModelReadBatchResponse>;
  readonly single: (read: ModelReadBatchItem) => Promise<ReadResult>;
}) {
  let pending: PendingRead[] = [];
  let pendingBytes = 12; // {"reads":[]}
  let timer: ReturnType<typeof setTimeout> | undefined;
  let supported = true;

  async function dispatch(reads: PendingRead[]): Promise<void> {
    if (reads.length === 1 || !supported) {
      await Promise.all(reads.map(async read => {
        try { read.resolve(await options.single(read.item)); }
        catch (error) { read.reject(error); }
      }));
      return;
    }
    const unique = new Map<string, PendingRead[]>();
    for (const read of reads) {
      const key = JSON.stringify(read.item);
      const same = unique.get(key);
      if (same) same.push(read);
      else unique.set(key, [read]);
    }
    const groups = [...unique.values()];
    try {
      const response = await options.send(groups.map(group => group[0]!.item));
      if (response.results.length !== groups.length) {
        throw new AbloConnectionError('The read batch returned an incomplete response.', { code: 'malformed_response' });
      }
      for (const [index, group] of groups.entries()) {
        const slot = response.results[index]!;
        if ('result' in slot) {
          const item = group[0]!.item;
          if (slot.result.model !== item.model ||
            (item.kind === 'read' ? slot.result.object !== 'model' || slot.result.id !== item.id
              : slot.result.object !== 'list')) {
            throw new AbloConnectionError('The read batch returned a mismatched result.', { code: 'malformed_response' });
          }
        }
      }
      for (const [index, group] of groups.entries()) {
        const slot = response.results[index]!;
        if ('error' in slot) {
          const error = translateHttpError(slot.status, slot.error, slot.error.request_id);
          for (const read of group) read.reject(error);
        } else {
          for (const read of group) read.resolve(group.length > 1 ? structuredClone(slot.result) : slot.result);
        }
      }
    } catch (error) {
      // Older servers have no batch route. Learn this once without masking a
      // denied read, a malformed response, or a failing deployed batch route.
      if (error instanceof AbloError && error.httpStatus === 404 && error.code === 'entity_not_found') {
        supported = false;
        await dispatch(reads);
      } else {
        for (const read of reads) read.reject(error);
      }
    }
  }

  function flush(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const reads = pending;
    pending = [];
    pendingBytes = 12;
    void dispatch(reads);
  }

  return {
    flush,
    read(item: ModelReadBatchItem): Promise<ReadResult> {
      return new Promise((resolve, reject) => {
        const bytes = new TextEncoder().encode(JSON.stringify(item)).length + 1;
        if (pendingBytes + bytes > MODEL_READ_BATCH_MAX_BYTES) flush();
        pending.push({ item, resolve, reject });
        pendingBytes += bytes;
        if (pending.length === MODEL_READ_BATCH_SIZE) flush();
        else timer ??= setTimeout(flush, 0);
      });
    },
  };
}
