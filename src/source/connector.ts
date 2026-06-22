/**
 * Customer-side Data Source reverse-channel connector.
 *
 * The dial-out half of the reverse channel (see `connector-protocol.ts`). The
 * customer runs this next to their database; it opens an OUTBOUND WebSocket to
 * Ablo Cloud and serves the `commit`/`load`/`list` leg over that socket instead
 * of receiving inbound webhooks. This is the symmetric primitive to
 * `createPushQueue` (which already gives the `events` leg an outbound transport)
 * and mirrors the Stripe CLI's `stripe listen`.
 *
 * The connector does NOT reimplement any handler logic. It wraps the SAME
 * `(request: Request) => Promise<Response>` the customer's deployed route uses:
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
 * Each drained `request` frame is replayed into a synthesized `Request` carrying
 * the original Standard Webhooks signature headers, so the handler verifies it
 * through the unchanged `verifyAbloSourceRequest` — identical to the webhook
 * path. The transport changes; the trust model does not.
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
} from './connector-protocol.js';

/** Default Ablo Cloud base. The connector appends `SOURCE_CONNECTOR_WS_PATH`. */
const DEFAULT_BASE_URL = 'https://api.abloatai.com';

/**
 * Reconnect backoff, in ms, indexed by consecutive failed connect attempts.
 * Unlike the (multi-day) Standard Webhooks delivery schedule, a long-lived
 * control socket should re-establish quickly and cap at a steady interval, so
 * this is a short capped curve. The last entry repeats for further attempts. A
 * clean `ready` resets the counter to 0.
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
 * Minimal structural WebSocket surface — the browser/`globalThis.WebSocket` API,
 * which Node 24+ implements natively. The `ws` package's default export also
 * satisfies this (it exposes `addEventListener`). Injectable for tests.
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
   * Ablo project API key. Defaults gate to `sk_test_*` (local-dev / sandbox);
   * an `sk_live_*` key is only accepted when the source has opted into
   * reverse-channel for production server-side.
   */
  readonly apiKey: string;
  /**
   * The unchanged Data Source handler — `dataSource(options)` /
   * `abloSource(options)`. The connector feeds it synthesized `Request`s and
   * relays the `Response`s back; it never inspects or alters them.
   */
  readonly handler: (request: Request) => Promise<Response>;
  /** Ablo Cloud base URL. Default `https://api.abloatai.com`. */
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
   * Run the connect → serve → reconnect loop until `signal` aborts. Resolves
   * when aborted. Rejects only on a fatal, non-retryable condition (e.g. no
   * WebSocket implementation available).
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
 * One connection lifecycle: open → register → serve drained requests until the
 * socket closes or `signal` aborts. Resolves to whether the connection reached
 * the `ready` state (used to reset reconnect backoff). Never rejects — transport
 * failures are normal and drive a reconnect.
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
        // Surface as a 500 so the server-side SourceClient treats it as a
        // retryable failure, exactly like a webhook endpoint throwing.
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
