/**
 * Opens the connector's side of the Data Source reverse channel. You run this
 * process next to your database; it dials an outbound WebSocket to Ablo and serves
 * the load, list, and commit requests over that socket, so a handler with no
 * public URL never needs to receive inbound webhooks. It is the counterpart to
 * `createPushQueue`, which gives the outbound events feed the same treatment, and
 * it speaks the frames defined in `connectorProtocol.ts`.
 *
 * The connector reimplements none of the handler logic. It wraps the same
 * `(request: Request) => Promise<Response>` your deployed route already uses:
 *
 *   import { dataSource, createSourceConnector } from '@abloatai/ablo';
 *   import { sourceOptions } from './ablo.source'; // shared with route.ts
 *
 *   const connector = createSourceConnector({
 *     apiKey: process.env.ABLO_API_KEY!,
 *     handler: dataSource(sourceOptions),
 *   });
 *   await connector.run(controller.signal);
 *
 * Each incoming `request` frame is replayed into a `Request` that carries the
 * original signature headers, so the handler verifies it through the same
 * `verifyAbloSourceRequest` it uses on the webhook path. The transport changes;
 * the trust model does not.
 */

import {
  SOURCE_CONNECTOR_PROTOCOL_VERSION,
  SOURCE_CONNECTOR_WS_PATH,
  sourceConnectorSubprotocols,
  encodeFrame,
  decodeFrame,
  ConnectorProtocolError,
  type ConnectorFrame,
  type RequestFrame,
  type ResponseFrame,
  type ReadyFrame,
} from './connectorProtocol.js';
import { ABLO_HOSTED_HTTP_BASE_URL } from '../client/hostedEndpoints.js';

/**
 * The default Ablo base URL the connector dials, to which it appends
 * `SOURCE_CONNECTOR_WS_PATH`.
 */
const DEFAULT_BASE_URL = ABLO_HOSTED_HTTP_BASE_URL;

/**
 * The reconnect backoff, in milliseconds, indexed by the number of consecutive
 * failed connect attempts. A long-lived control socket should recover quickly and
 * then settle at a steady interval, so this is a short curve that caps rather than
 * growing without bound. The final entry repeats for any further attempts, and a
 * connection that reaches `ready` resets the count to zero.
 */
export const DEFAULT_RECONNECT_SCHEDULE: readonly number[] = [
  0, // immediate first reconnect
  1_000, // 1s
  2_000, // 2s
  5_000, // 5s
  10_000, // 10s
  30_000, // 30s (steady state)
];

/**
 * The minimal WebSocket surface the connector needs, matching the standard
 * `globalThis.WebSocket` API that browsers and current Node versions provide. The
 * `ws` package's default export also satisfies it. Supply your own implementation
 * to substitute a fake in tests.
 */
export interface ConnectorWebSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: 'close',
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

export type ConnectorWebSocketFactory = (
  url: string,
  protocols: readonly string[],
) => ConnectorWebSocket;

/** Lifecycle of the connector's socket, surfaced via `onStatus`. */
export type ConnectorStatus = 'connecting' | 'ready' | 'disconnected';

export interface SourceConnectorOptions {
  /**
   * Your Ablo project API key. A test key (`sk_test_*`) works by default for local
   * development and sandboxes; a live key (`sk_live_*`) is accepted only once the
   * source has opted the reverse channel in for production use.
   */
  readonly apiKey: string;
  /**
   * The Data Source handler to serve, as returned by `dataSource(options)` or
   * `abloSource(options)`. The connector feeds it each request and relays the
   * response back untouched; it never inspects or alters either one.
   */
  readonly handler: (request: Request) => Promise<Response>;
  /** The Ablo base URL to dial. Defaults to `https://api.abloatai.com`. */
  readonly baseURL?: string;
  /** Inject a WebSocket implementation. Default `globalThis.WebSocket`. */
  readonly webSocket?: ConnectorWebSocketFactory;
  /** Override reconnect backoff. Default `DEFAULT_RECONNECT_SCHEDULE`. */
  readonly reconnectSchedule?: readonly number[];
  /** Random jitter on reconnect delays. Default ±10%. Set 0 to disable. */
  readonly jitter?: number;
  /** Advisory client id sent in the `register` frame for server-side logs. */
  readonly client?: string;
  /** Pluggable clock (tests). */
  readonly now?: () => number;
  /** Observe connection lifecycle transitions. */
  readonly onStatus?: (status: ConnectorStatus) => void;
  /** Observe non-fatal errors (decode failures, handler throws, socket errors). */
  readonly onError?: (error: unknown) => void;
}

export interface SourceConnector {
  /**
   * Runs the connect, serve, and reconnect loop until `signal` aborts, then
   * resolves. It rejects only on a fatal condition that cannot be retried, such as
   * no WebSocket implementation being available.
   */
  run(signal: AbortSignal): Promise<void>;
}

export function createSourceConnector(
  options: SourceConnectorOptions,
): SourceConnector {
  const baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = toWebSocketUrl(baseURL) + SOURCE_CONNECTOR_WS_PATH;
  const schedule = options.reconnectSchedule ?? DEFAULT_RECONNECT_SCHEDULE;
  const jitter = options.jitter ?? 0.1;
  const factory = options.webSocket ?? defaultWebSocketFactory;

  return {
    async run(signal) {
      let attempt = 0;
      while (!signal.aborted) {
        const delay = backoffFor(schedule, attempt, jitter);
        if (delay > 0) await sleep(delay, signal);
        if (signal.aborted) return;

        options.onStatus?.('connecting');
        const becameReady = await connectOnce({
          url,
          apiKey: options.apiKey,
          handler: options.handler,
          factory,
          client: options.client,
          onStatus: options.onStatus,
          onError: options.onError,
          signal,
        });
        // A connection that reached `ready` resets the backoff so the next
        // drop reconnects immediately; one that never readied keeps escalating.
        attempt = becameReady ? 0 : attempt + 1;
      }
    },
  };
}

/**
 * Runs one connection: open the socket, register, then serve requests until the
 * socket closes or `signal` aborts. Resolves to whether the connection reached the
 * `ready` state, which the caller uses to reset the reconnect backoff. It never
 * rejects, because a dropped transport is expected and simply drives a reconnect.
 */
function connectOnce(params: {
  readonly url: string;
  readonly apiKey: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly factory: ConnectorWebSocketFactory;
  readonly client: string | undefined;
  readonly onStatus: ((status: ConnectorStatus) => void) | undefined;
  readonly onError: ((error: unknown) => void) | undefined;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let ws: ConnectorWebSocket;
    try {
      ws = params.factory(
        params.url,
        sourceConnectorSubprotocols(params.apiKey),
      );
    } catch (err) {
      params.onError?.(err);
      resolve(false);
      return;
    }

    let ready = false;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      params.signal.removeEventListener('abort', onAbort);
      params.onStatus?.('disconnected');
      resolve(ready);
    };

    const onAbort = (): void => {
      try {
        ws.close(1000, 'connector_aborted');
      } catch {
        // Already closing/closed.
      }
      finish();
    };
    params.signal.addEventListener('abort', onAbort, { once: true });

    ws.addEventListener('open', () => {
      send(ws, {
        type: 'register',
        protocolVersion: SOURCE_CONNECTOR_PROTOCOL_VERSION,
        ...(params.client ? { client: params.client } : {}),
      });
    });

    ws.addEventListener('message', (event) => {
      let frame: ConnectorFrame;
      try {
        frame = decodeFrame(event.data as string | ArrayBuffer | Uint8Array);
      } catch (err) {
        params.onError?.(
          err instanceof ConnectorProtocolError
            ? err
            : new ConnectorProtocolError(String(err)),
        );
        return;
      }
      handleFrame(frame);
    });

    ws.addEventListener('error', (event) => {
      params.onError?.(event);
      // `close` always follows `error`; finish() runs there.
    });

    ws.addEventListener('close', () => {
      finish();
    });

    function handleFrame(frame: ConnectorFrame): void {
      switch (frame.type) {
        case 'ready':
          handleReady(frame);
          return;
        case 'request':
          // Do not await — serve each request concurrently so a slow handler
          // never blocks draining the next frame off the socket.
          void serveRequest(frame);
          return;
        case 'error':
          params.onError?.(
            new ConnectorProtocolError(`${frame.code}: ${frame.message}`),
          );
          return;
        // `register`/`response` are connector→server only; ignore if echoed.
        case 'register':
        case 'response':
          return;
      }
    }

    function handleReady(frame: ReadyFrame): void {
      if (frame.protocolVersion !== SOURCE_CONNECTOR_PROTOCOL_VERSION) {
        params.onError?.(
          new ConnectorProtocolError(
            `Server protocol version ${frame.protocolVersion} != ${SOURCE_CONNECTOR_PROTOCOL_VERSION}`,
          ),
        );
        try {
          ws.close(1002, 'protocol_version_mismatch');
        } catch {
          // closing
        }
        return;
      }
      ready = true;
      params.onStatus?.('ready');
    }

    async function serveRequest(frame: RequestFrame): Promise<void> {
      const response = await runHandler(frame);
      // Best-effort: if the socket dropped while the handler ran, the server
      // times the request out and the SDK retries — same as a webhook timeout.
      send(ws, response);
    }

    async function runHandler(frame: RequestFrame): Promise<ResponseFrame> {
      try {
        const request = new Request(frame.url, {
          method: frame.method,
          headers: frame.headers,
          body: frame.body,
        });
        const result = await params.handler(request);
        const body = await result.text();
        return {
          type: 'response',
          id: frame.id,
          status: result.status,
          body,
        };
      } catch (err) {
        params.onError?.(err);
        // Surface this as a 500 so Ablo treats it as a retryable failure, exactly
        // as it would a webhook endpoint that threw.
        return {
          type: 'response',
          id: frame.id,
          status: 500,
          body: JSON.stringify({
            error: 'source_connector_handler_error',
            message: err instanceof Error ? err.message : String(err),
          }),
        };
      }
    }

    function send(socket: ConnectorWebSocket, frame: ConnectorFrame): void {
      try {
        socket.send(encodeFrame(frame));
      } catch (err) {
        params.onError?.(err);
      }
    }
  });
}

function defaultWebSocketFactory(
  url: string,
  protocols: readonly string[],
): ConnectorWebSocket {
  const Ctor = (
    globalThis as {
      WebSocket?: new (
        url: string,
        protocols?: string | readonly string[],
      ) => ConnectorWebSocket;
    }
  ).WebSocket;
  if (!Ctor) {
    throw new Error(
      'No global WebSocket available. Pass `webSocket` (e.g. the `ws` package) to createSourceConnector.',
    );
  }
  return new Ctor(url, protocols);
}

/** `http(s)://` → `ws(s)://`. Leaves an explicit `ws(s)` scheme untouched. */
function toWebSocketUrl(baseURL: string): string {
  if (baseURL.startsWith('https://')) return `wss://${baseURL.slice('https://'.length)}`;
  if (baseURL.startsWith('http://')) return `ws://${baseURL.slice('http://'.length)}`;
  return baseURL;
}

function backoffFor(
  schedule: readonly number[],
  attempt: number,
  jitter: number,
): number {
  if (attempt <= 0) return 0;
  const base = schedule[Math.min(attempt, schedule.length - 1)] ?? 0;
  if (jitter <= 0 || base === 0) return base;
  const swing = base * jitter;
  return Math.max(0, base + (Math.random() * 2 - 1) * swing);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
