/**
 * The wire protocol for the Data Source reverse channel — the frames that travel
 * over the WebSocket a connector opens to Ablo.
 *
 * The load, list, and commit leg of a Data Source normally arrives as an inbound
 * webhook that Ablo posts to your HTTPS endpoint. That needs a public URL, so it
 * cannot reach a handler running on localhost or inside a private network with no
 * inbound path. The reverse channel flips the direction: the connector dials out
 * to Ablo over a WebSocket and serves those same requests back over the open
 * socket. This module defines the frames exchanged on that socket.
 *
 * The trust model does not change. A `request` frame carries the same signature
 * headers (`webhook-id`, `webhook-timestamp`, `webhook-signature`) and the same
 * raw body Ablo would have posted, so the connector verifies it through
 * `verifyAbloSourceRequest` exactly as it would a webhook. Only the transport
 * differs.
 *
 * Frames are validated with Zod as they arrive, the same discipline `contract.ts`
 * applies to change sets: a malformed frame is rejected at the boundary, and both
 * sides infer every wire type from one schema so they cannot silently drift.
 */

import { z } from 'zod';

import { environmentSchema } from '../environment.js';
import { WS_BEARER_SUBPROTOCOL_PREFIX } from '../auth/credentialSource.js';

/**
 * The wire-protocol version. It increases on any breaking change to a frame's
 * shape, so a connector and server on mismatched versions fail fast during
 * `register` rather than misparsing a frame later in the stream.
 */
export const SOURCE_CONNECTOR_PROTOCOL_VERSION = 1;

/** The WebSocket path the connector dials, appended to its configured base URL. */
export const SOURCE_CONNECTOR_WS_PATH = '/v1/source/listen';

/**
 * The WebSocket subprotocol that identifies a reverse-channel source connector,
 * as opposed to the SDK's sync client, which uses `ablo.sync.v1`. During the
 * handshake the server echoes back only this value and never the subprotocol that
 * carries the credential, keeping the API key out of proxy and load-balancer logs.
 */
export const WS_SOURCE_SUBPROTOCOL = 'ablo.source.v1';

/**
 * Builds the `Sec-WebSocket-Protocol` list a connector offers during the
 * handshake: the source subprotocol followed by the bearer credential, encoded as
 * `ablo.bearer.<apiKey>`. A WebSocket handshake cannot carry an `Authorization`
 * header, so the API key rides as a subprotocol instead — the same mechanism the
 * SDK's sync client uses, which the server reads back with `extractBearer`.
 */
export function sourceConnectorSubprotocols(apiKey: string): string[] {
  return [WS_SOURCE_SUBPROTOCOL, `${WS_BEARER_SUBPROTOCOL_PREFIX}${apiKey}`];
}

const headerRecord = z.record(z.string(), z.string());

/**
 * The first frame the connector sends, right after the socket opens. The server
 * has already authenticated the connection and resolved which source it serves
 * from the API key in the handshake, so this frame only negotiates the protocol
 * version and carries advisory metadata.
 */
export const registerFrameSchema = z.object({
  type: z.literal('register'),
  protocolVersion: z.number().int(),
  /**
   * An optional client identifier, such as `@abloatai/ablo@0.12.0`, recorded in
   * the server's logs. It is advisory only and never affects a decision.
   */
  client: z.string().optional(),
});
export type RegisterFrame = z.infer<typeof registerFrameSchema>;

/**
 * The server's acknowledgement of a successful `register`. It echoes the resolved
 * source identity so the connector can confirm and log which source it is serving.
 */
export const readyFrameSchema = z.object({
  type: z.literal('ready'),
  protocolVersion: z.number().int(),
  sourceId: z.string().optional(),
  organizationId: z.string().optional(),
  environment: environmentSchema.optional(),
});
export type ReadyFrame = z.infer<typeof readyFrameSchema>;

/**
 * A single load, list, or commit request the server forwards to the connector.
 * Its `headers` and `body` are byte-for-byte what the inbound webhook path would
 * have sent, so the connector can replay them into a `Request` and let the same
 * handler verify the signature exactly as it would for a webhook.
 */
export const requestFrameSchema = z.object({
  type: z.literal('request'),
  /** Correlation id; the matching `response` frame carries the same value. */
  id: z.string().min(1),
  method: z.literal('POST'),
  /** Synthetic absolute URL used only to construct the `Request` object. */
  url: z.string().min(1),
  /** The signed webhook signature headers, plus `Content-Type`. */
  headers: headerRecord,
  /** Raw JSON request body — exactly the bytes that were signed. */
  body: z.string(),
});
export type RequestFrame = z.infer<typeof requestFrameSchema>;

/**
 * The handler's response to one `request` frame, sent back by the connector. The
 * server matches it to the pending request by `id` and treats its `status` and
 * `body` as though an HTTP response had returned.
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
 * An error either side can send for a failure that is not a normal request
 * result, such as a rejected credential, an unsupported protocol version, or a
 * malformed frame. When `id` is set the error belongs to that pending request and
 * fails it; without an `id` it is a connection-level error.
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
 * Parses and validates one incoming frame. It accepts either the string or the
 * binary payloads a WebSocket `message` event can deliver, and throws
 * {@link ConnectorProtocolError} on any malformed or unrecognized frame so the
 * caller can reject the connection instead of acting on bad data.
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
