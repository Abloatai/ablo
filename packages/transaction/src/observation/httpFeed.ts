import { formatFeedCursor, parseFeedCursor } from './cursor.js';
import type { HttpLogsResource } from '../client/resources/httpResources.js';
import type {
  ObserveOptions,
  ObservedDelta,
} from '../client/contract.js';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEDUPE_WINDOW_SIZE = 400;

function normalizeOptions(
  input: ObserveOptions | string | readonly string[] | undefined,
): ObserveOptions {
  if (typeof input === 'string') return { models: input };
  if (Array.isArray(input)) return { models: input as readonly string[] };
  return (input as ObserveOptions | undefined) ?? {};
}

function cancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Observation was cancelled.');
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, ms);

    function finish(): void {
      signal?.removeEventListener('abort', abort);
      resolve();
    }

    function abort(): void {
      clearTimeout(timer);
      reject(cancelled(signal!));
    }

    signal?.addEventListener('abort', abort, { once: true });
  });
}

export function createHttpFeed(
  logs: HttpLogsResource,
): (
  input?: ObserveOptions | string | readonly string[],
) => AsyncIterable<ObservedDelta> {
  return async function* observe(input): AsyncIterable<ObservedDelta> {
    const options = normalizeOptions(input);
    const cursorKey = options.cursorKey ?? 'default';
    const storedCursor = options.cursorStore
      ? await options.cursorStore.load(cursorKey)
      : null;
    let after = options.after ?? storedCursor ?? undefined;
    const models = typeof options.models === 'string'
      ? [options.models]
      : options.models ?? [];
    const requestedModels = new Set(models.map((model) => model.toLowerCase()));
    const delivered = new Set<string>();

    while (true) {
      if (options.signal?.aborted) throw cancelled(options.signal);
      const page = await logs.list({
        ...(after !== undefined ? { after } : {}),
        limit: DEFAULT_PAGE_SIZE,
        ...(requestedModels.size === 1
          ? { model: requestedModels.values().next().value }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const nextCursor = page.next_cursor ?? after;
      const parsedCursor = nextCursor ? parseFeedCursor(nextCursor) : null;

      for (const event of page.data) {
        if (event.object !== 'log_event' || event.delta === undefined) continue;
        if (
          requestedModels.size > 0
          && !requestedModels.has(event.model.toLowerCase())
        ) {
          continue;
        }
        const deliveryKey = `log:${event.id}`;
        if (delivered.has(deliveryKey)) continue;
        delivered.add(deliveryKey);
        if (delivered.size > DEDUPE_WINDOW_SIZE) {
          const oldest = delivered.values().next().value;
          if (oldest !== undefined) delivered.delete(oldest);
        }
        const cursor = formatFeedCursor({
          log: event.id,
          claims: parsedCursor?.claims ?? 0,
        });
        yield {
          ...event.delta,
          cursor,
          checkpoint: () => options.cursorStore?.save(cursorKey, cursor)
            ?? Promise.resolve(),
        };
      }

      if (nextCursor !== undefined) after = nextCursor;
      if (page.has_more) continue;
      await pause(
        Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS),
        options.signal,
      );
    }
  };
}
