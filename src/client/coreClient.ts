/**
 * The core client over the socket: the stateless surface plus the live feed
 * (ADR 0016). `Ablo({ ..., plugins: [] })` returns this — the empty list says
 * it plainly: nothing beyond the core. Reads and writes travel over
 * request-response, exactly as they do for the `transport: 'http'` client;
 * the socket adds push — deltas, presence frames, and the claim lifecycle
 * (granted, queued, lost) — without a local copy of anything.
 *
 * This is the membership test made constructible: a caller with no socket
 * loses only push, and polls instead; a caller with this client gets the
 * push back and still never holds a store it did not ask for. It also
 * satisfies the core coordination ports structurally — `awaitClaimGrant`
 * needs only `subscribe`, which this client has.
 */

import type { SchemaRecord } from '../transaction/schema/schema.js';
import {
  createAbloHttpClient,
  type AbloHttpClient,
} from '../transaction/transport/httpClient.js';
import { WsTransport } from '../transaction/transport/wsTransport.js';
import { createClaimStream } from '../sync/createClaimStream.js';
import type { ClaimStream } from '../transaction/types/streams.js';
import { AbloConnectionError } from '../transaction/errors.js';
import type { Logger } from '../transaction/logger.js';
import type { ObservabilityProvider } from '../interfaces/index.js';
import type { AbloOptions } from './options.js';
import type { ParticipantKind } from '../transaction/types/participant.js';

/**
 * The stateless surface plus the live feed. Everything `transport: 'http'`
 * offers — typed model reads and writes, commits, claims, session minting —
 * with a duplex connection alongside it for the frames the server initiates.
 */
export type AbloCoreClient<S extends SchemaRecord> = AbloHttpClient<S> & {
  /**
   * Opens the live feed and resolves once the connection is up. Reads and
   * writes work before, during, and after — they never depend on the feed.
   */
  connect(options?: { timeoutMs?: number }): Promise<void>;
  /** Closes the live feed. Reads and writes keep working over request-response. */
  disconnect(): void;
  /** True while the live feed is up. */
  isConnected(): boolean;
  /**
   * Subscribe to pushed frames — deltas, presence updates, claim grants and
   * losses. Returns the unsubscribe function.
   */
  subscribe: WsTransport['subscribe'];
  /** Other participants' open claims and the wait queues, kept live off the feed. */
  claims: ClaimStream;
};

export interface CoreClientArgs<S extends SchemaRecord> {
  options: AbloOptions<S>;
  /** The resolved sync-server base URL. */
  baseUrl: string;
  participantId: string;
  kind: ParticipantKind;
  syncGroups: readonly string[];
  /** The shared credential source's resolver — reconnects read the freshest token. */
  getAuthToken: () => string | null | undefined;
  logger: Logger;
  observability?: ObservabilityProvider;
}

/** How long `connect()` waits before reporting the feed did not come up. */
const CONNECT_TIMEOUT_MS = 10_000;

export function createCoreClient<S extends SchemaRecord>(
  args: CoreClientArgs<S>,
): AbloCoreClient<S> {
  const { options } = args;

  // The stateless surface — the same construction `transport: 'http'` uses,
  // fed the same option slice. The endpoint-form `apiKey` (or the legacy
  // `authEndpoint`) mints and renews exactly as it does there.
  const http = createAbloHttpClient<S>({
    schema: options.schema,
    apiKey: options.apiKey ?? options.authEndpoint,
    baseURL: args.baseUrl,
    fetch: options.fetch,
    defaultHeaders: options.defaultHeaders,
    defaultQuery: options.defaultQuery,
    dangerouslyAllowBrowser: options.dangerouslyAllowBrowser,
    observability: args.observability,
    durableWrites: options.durableWrites,
    // Forwarding the compatibility aliases IS the compatibility: a caller still
    // on the old pair reaches the HTTP client only through here, so this hand-off
    // has to outlive the deprecation notice. It goes when the aliases do.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
    commitOutbox: options.commitOutbox,
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
    commitOutboxScope: options.commitOutboxScope,
  });

  // The live feed. Constructed eagerly (a socket object holds no connection
  // until `connect()`), with identity riding the bearer — the server never
  // reads identity fields from the client.
  const socket = new WsTransport({
    baseUrl: args.baseUrl,
    kind: args.kind,
    getAuthToken: args.getAuthToken,
    syncGroups: [...args.syncGroups],
    collaborationEvents: [...(options.collaborationEvents ?? [])],
    logger: args.logger,
    observability: args.observability,
  });

  // Claim push is core coordination: the stream attaches to the socket now
  // and starts reporting the moment the feed opens.
  const claims = createClaimStream(
    { participantId: args.participantId, logger: args.logger },
    socket,
  );

  function connect(opts?: { timeoutMs?: number }): Promise<void> {
    if (socket.isConnected()) return Promise.resolve();
    const timeoutMs = opts?.timeoutMs ?? CONNECT_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const offs: (() => void)[] = [];
      let done = false;
      const settle = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const off of offs) off();
        fn();
      };
      offs.push(socket.subscribe('connected', () => { settle(resolve); }));
      offs.push(
        socket.subscribe('handshake_failed', (event) => {
          settle(() => {
            reject(
              new AbloConnectionError(
                `The live feed's connection was refused (close code ${event.code}). ` +
                  'Check the credential and the server URL; reads and writes still work without the feed.',
                { code: 'ws_not_ready' },
              ),
            );
          });
        }),
      );
      offs.push(
        socket.subscribe('reconnect_failed', ({ attempts }) => {
          settle(() => {
            reject(
              new AbloConnectionError(
                `The live feed did not come up after ${attempts} attempts. ` +
                  'Reads and writes still work without it; call connect() again to retry.',
                { code: 'ws_not_ready' },
              ),
            );
          });
        }),
      );
      const timer = setTimeout(() => {
        settle(() => {
          reject(
            new AbloConnectionError(
              `The live feed did not connect within ${timeoutMs}ms. ` +
                'Reads and writes still work without it; call connect() again to retry.',
              { code: 'ws_not_ready' },
            ),
          );
        });
      }, timeoutMs);
      socket.connect();
    });
  }

  // The feed members layered over the stateless surface. `dispose` is
  // deliberately shadowed: closing the client closes the feed too.
  const feed: Record<string, unknown> = {
    connect,
    disconnect: () => { socket.disconnect(); },
    isConnected: () => socket.isConnected(),
    subscribe: socket.subscribe.bind(socket),
    claims,
    dispose: async (): Promise<void> => {
      claims.dispose();
      socket.disconnect();
      await http.dispose();
    },
  };

  return new Proxy(http, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in feed) return feed[prop];
      return Reflect.get(target, prop, receiver);
    },
  }) as AbloCoreClient<S>;
}
