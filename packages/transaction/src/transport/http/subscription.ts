import type { ReadDependency } from '../../coordination/schema.js';
import {
  AbloStaleContextError,
  translateHttpError,
} from '../../errors.js';

export interface HttpReadOnChangeDeps {
  readonly fetch: typeof fetch;
  readonly endpoint: () => string;
  readonly authHeaders: () => Promise<Record<string, string>>;
  readonly prepare: () => Promise<void>;
  readonly register: (controller: AbortController) => void;
  readonly unregister: (controller: AbortController) => void;
}

export type HttpReadOnChange = (
  reads: readonly ReadDependency[],
  listener: (error: AbloStaleContextError) => void,
) => () => void;

const INITIAL_RECONNECT_CAP_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/** POST the existing reads and consume one `stale_context` SSE event. */
export function createHttpReadOnChange(deps: HttpReadOnChangeDeps): HttpReadOnChange {
  return (reads, listener) => {
    if (reads.length === 0) return () => undefined;

    const controller = new AbortController();
    deps.register(controller);
    let stopped = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      deps.unregister(controller);
    };

    void (async () => {
      let failures = 0;
      while (!stopped) {
        try {
          await deps.prepare();
          const response = await deps.fetch(deps.endpoint(), {
            method: 'POST',
            headers: {
              ...(await deps.authHeaders()),
              Accept: 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ reads }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const body = await parseResponseBody(response);
            throw translateHttpError(
              response.status,
              body,
              response.headers.get('x-request-id') ?? undefined,
            );
          }

          failures = 0;
          const stale = await readStaleContextEvent(response);
          if (stale) {
            stop();
            listener(stale);
            return;
          }
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          void error;
        }

        failures += 1;
        await abortableDelay(reconnectDelayMs(failures), controller.signal);
      }
    })().finally(() => deps.unregister(controller));

    return stop;
  };
}

/** Full-jitter reconnect delay; exported only for transport unit tests. */
export function reconnectDelayMs(failures: number, random = Math.random): number {
  const cap = Math.min(
    MAX_RECONNECT_DELAY_MS,
    INITIAL_RECONNECT_CAP_MS * 2 ** Math.max(0, failures - 1),
  );
  return random() * cap;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function readStaleContextEvent(
  response: Response,
): Promise<AbloStaleContextError | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = eventBoundary(buffer);
    while (boundary) {
      const block = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const parsed = parseEventBlock(block);
      if (parsed?.event === 'stale_context') {
        let body: unknown;
        try {
          body = JSON.parse(parsed.data) as unknown;
        } catch {
          body = parsed.data;
        }
        const error = translateHttpError(409, body);
        return error instanceof AbloStaleContextError
          ? error
          : new AbloStaleContextError(error.message, {
              code: 'stale_context',
              cause: error,
            });
      }
      boundary = eventBoundary(buffer);
    }
    if (done) return undefined;
  }
}

function eventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseEventBlock(block: string): { event: string; data: string } | undefined {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : undefined;
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
