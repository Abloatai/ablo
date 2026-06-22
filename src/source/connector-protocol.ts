/**
 * Data Source reverse-channel wire protocol.
 *
 * The `commit`/`load`/`list` leg of Data Source mode is normally an INBOUND
 * webhook (Ablo Cloud → your HTTPS endpoint). That requires a public URL, so it
 * doesn't work on `localhost` or inside a locked-down VPC with no inbound path.
 *
 * The reverse channel inverts the direction: the customer's connector dials OUT
 * to Ablo Cloud over a WebSocket and serves those same requests over the open
 * socket — the Stripe-CLI `stripe listen` pattern. This module defines the
 * frames that travel over that socket.
 *
 * Trust model is unchanged. A `request` frame carries the SAME Standard Webhooks
 * signature headers (`webhook-id` / `webhook-timestamp` / `webhook-signature`)
 * and the SAME raw body Ablo would have POSTed, so the connector verifies it
 * through the unchanged `verifyAbloSourceRequest`. Only the transport differs.
 *
 * Frames are validated with zod at the boundary (matching `contract.ts`): a
 * malformed frame is rejected at the edge, and every wire type is inferred from
 * one schema so the two sides can never silently drift.
 */

import { z } from 'zod';

import { WS_BEARER_SUBPROTOCOL_PREFIX } from '../auth/credentialSource.js';

/**
 * Wire-protocol version. Bumped on any breaking frame-shape change so an old
 * connector talking to a new server (or vice-versa) fails fast at `register`
 * instead of misparsing a frame mid-stream.
 */
export const SOURCE_CONNECTOR_PROTOCOL_VERSION = 1;

/** Path the connector dials. Appended to the connector's `baseURL`. */
export const SOURCE_CONNECTOR_WS_PATH = '/v1/source/listen';

/**
 * Negotiated WebSocket subprotocol that marks a reverse-channel source
 * connector (vs. the SDK sync client's `ablo.sync.v1`). The server selects and
 * echoes back ONLY this value, never the token-bearing subprotocol — keeping the
 * credential out of ALB / proxy logs exactly like the sync socket does.
 */
export const WS_SOURCE_SUBPROTOCOL = 'ablo.source.v1';

/**
 * Build the `Sec-WebSocket-Protocol` list a connector offers: the source
 * protocol plus the bearer credential (`ablo.bearer.<apiKey>`). Browsers can't
 * set an `Authorization` header on a WebSocket, so the API key rides as a
 * subprotocol — the same mechanism the SDK sync client uses, read server-side by
 * the shared `extractBearer`.
 */
export function sourceConnectorSubprotocols(apiKey: string): string[] {
  return [WS_SOURCE_SUBPROTOCOL, `${WS_BEARER_SUBPROTOCOL_PREFIX}${apiKey}`];
}

const headerRecord = z.record(z.string(), z.string());

/**
 * Connector → server, first frame after the socket opens and authenticates.
 * Auth and source resolution happen at the WS handshake from the API key; this
 * frame only carries protocol negotiation + advisory metadata.
 */
export const registerFrameSchema = z.object({
  type: z.literal('register'),
  protocolVersion: z.number().int(),
  /**
   * Advisory client identifier (e.g. `@abloatai/ablo@0.12.0`) for server-side
   * logging. Not trusted for any decision.
   */
  client: z.string().optional(),
});
export type RegisterFrame = z.infer<typeof registerFrameSchema>;

/**
 * Server → connector, acknowledges a successful `register`. Echoes the resolved
 * source identity so the connector can log/verify which source it is serving.
 */
export const readyFrameSchema = z.object({
  type: z.literal('ready'),
  protocolVersion: z.number().int(),
  sourceId: z.string().optional(),
  organizationId: z.string().optional(),
  environment: z.enum(['production', 'sandbox']).optional(),
});
export type ReadyFrame = z.infer<typeof readyFrameSchema>;

/**
 * Server → connector, one drained `commit`/`load`/`list` request. `headers` and
 * `body` are byte-identical to what the inbound webhook path would have sent —
 * the connector replays them into a synthesized `Request` so the unchanged
 * handler verifies the signature exactly as in production.
 */
export const requestFrameSchema = z.object({
  type: z.literal('request'),
  /** Correlation id; the matching `response` frame carries the same value. */
  id: z.string().min(1),
  method: z.literal('POST'),
  /** Synthetic absolute URL used only to construct the `Request` object. */
  url: z.string().min(1),
  /** Signed Standard Webhooks headers + `Content-Type`. */
  headers: headerRecord,
  /** Raw JSON request body — exactly the bytes that were signed. */
  body: z.string(),
});
export type RequestFrame = z.infer<typeof requestFrameSchema>;

/**
 * Connector → server, the handler's `Response` for one `request`. The server
 * resolves the pending request keyed by `id` and feeds `status`/`body` back to
 * the `SourceClient` as if an HTTP response had returned.
 */
export const responseFrameSchema = z.object({
  type: z.literal('response'),
  id: z.string().min(1),
  status: z.number().int(),
  headers: headerRecord.optional(),
  /** Raw JSON response body. */
  body: z.string(),
});
export type ResponseFrame = z.infer<typeof responseFrameSchema>;

/**
 * Either direction, out-of-band failure not tied to a single request body
 * (auth rejected, unsupported protocol version, malformed frame). When `id` is
 * present the error pertains to that pending request and fails it; otherwise it
 * is a connection-level error.
 */
export const errorFrameSchema = z.object({
  type: z.literal('error'),
  id: z.string().min(1).optional(),
  code: z.string().min(1),
  message: z.string(),
});
export type ErrorFrame = z.infer<typeof errorFrameSchema>;

export const connectorFrameSchema = z.discriminatedUnion('type', [
  registerFrameSchema,
  readyFrameSchema,
  requestFrameSchema,
  responseFrameSchema,
  errorFrameSchema,
]);
export type ConnectorFrame = z.infer<typeof connectorFrameSchema>;

/** Thrown when an incoming frame fails to parse or validate. */
export class ConnectorProtocolError extends Error {
  readonly code = 'source_connector_protocol_error';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorProtocolError';
  }
}

/** Serialize a frame for transmission. */
export function encodeFrame(frame: ConnectorFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse + validate an incoming frame. Accepts the string or binary payloads the
 * `ws` library / WebSocket `message` events deliver. Throws
 * `ConnectorProtocolError` on any malformed or unknown frame so callers can
 * reject the connection rather than act on garbage.
 */
export function decodeFrame(
  raw: string | ArrayBuffer | Uint8Array,
): ConnectorFrame {
  const text = typeof raw === 'string' ? raw : decodeBinary(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConnectorProtocolError('Frame is not valid JSON');
  }
  const result = connectorFrameSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConnectorProtocolError(
      `Invalid connector frame: ${result.error.message}`,
    );
  }
  return result.data;
}

function decodeBinary(raw: ArrayBuffer | Uint8Array): string {
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return new TextDecoder().decode(bytes);
}
