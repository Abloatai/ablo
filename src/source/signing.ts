/**
 * Signs and verifies source requests using the Standard Webhooks scheme.
 *
 * Every request Ablo sends to a data source is signed with that source's API
 * key, and the receiving endpoint verifies the signature before any handler
 * runs. This module provides both halves: {@link signAbloSourceRequest} for
 * the sender and {@link verifyAbloSourceRequest} for the receiver. Because the
 * signature format follows the Standard Webhooks specification, you can verify
 * it with any compatible library instead of these functions if you prefer.
 */

/** Inputs to {@link signAbloSourceRequest}. */
export interface SourceSignatureOptions {
  /** The API key to sign with; the receiver verifies against the same key. */
  readonly apiKey: string;
  /** The exact request body being signed. */
  readonly body: string;
  /**
   * The unique message id, sent as the `webhook-id` header. It is folded into
   * the signature to defend against replay, and receivers may deduplicate on
   * it. Retries of the same request must reuse the same id.
   */
  readonly messageId: string;
  /** The signing time as a Unix timestamp in seconds. Defaults to the current time. */
  readonly timestamp?: number;
}

/** Inputs to {@link verifyAbloSourceRequest}. */
export interface SourceSignatureVerificationOptions {
  /**
   * The incoming request, whose headers carry the signature to check. Any
   * request-shaped object works: a fetch `Request` (its `Headers` is read with
   * `.get`), or a plain header record like Node's `req.headers` — matching
   * what the runtime has always accepted.
   */
  readonly request: {
    readonly headers?: Headers | Record<string, string | string[] | undefined>;
  };
  /** The request body, which must match what was signed. */
  readonly body: string;
  /** The API key to verify against. */
  readonly apiKey: string;
  /**
   * How far the request's timestamp may differ from the current clock, in
   * milliseconds, before it is rejected as expired. Defaults to five minutes.
   */
  readonly toleranceMs?: number;
}

/** What {@link verifyAbloSourceRequest} returns once a signature checks out. */
export interface SourceSignatureVerificationResult {
  /** The verified `webhook-id` of the request. */
  readonly messageId: string;
  /** The time the request was signed, as a Unix timestamp in seconds. */
  readonly signedAt: number;
}

/**
 * The HTTP header names carried on a signed source request. They follow the
 * Standard Webhooks specification (https://www.standardwebhooks.com/), so you
 * can verify the signature with any compatible library rather than
 * {@link verifyAbloSourceRequest} if you prefer.
 */
export const ABLO_SOURCE_HEADERS = {
  signature: 'webhook-signature',
  timestamp: 'webhook-timestamp',
  id: 'webhook-id',
  idempotencyKey: 'Idempotency-Key',
} as const;

/**
 * Thrown when a source request fails signature verification. The
 * {@link SourceSignatureError.code} names the specific reason — a missing
 * header, a malformed or expired timestamp, or a signature that does not
 * match.
 */
export class SourceSignatureError extends Error {
  readonly code:
    | 'source_signature_missing'
    | 'source_id_missing'
    | 'source_timestamp_missing'
    | 'source_timestamp_invalid'
    | 'source_timestamp_expired'
    | 'source_signature_invalid'
    | 'source_forbidden';

  constructor(code: SourceSignatureError['code'], message: string) {
    super(message);
    this.name = 'SourceSignatureError';
    this.code = code;
  }
}

const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

function getHeader(
  request: SourceSignatureVerificationOptions['request'],
  name: string,
): string | null {
  const headers = request.headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()] ?? null;
  // Node folds repeated headers into an array; the signature headers are
  // single-valued, so the first entry is the one that was signed.
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Parse a `webhook-signature` header per the Standard Webhooks spec.
 * Values are space-delimited `<scheme>,<base64>` pairs (e.g.
 * `v1,abc== v1,def==` during a key rotation window). Returns the set
 * of `v1` signatures so the verifier can accept any of them.
 */
function parseSignatureHeader(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/\s+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const commaAt = trimmed.indexOf(',');
    if (commaAt === -1) continue;
    const scheme = trimmed.slice(0, commaAt);
    const value = trimmed.slice(commaAt + 1);
    if (scheme === 'v1' && value.length > 0) {
      out.push(value);
    }
  }
  return out;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  // Node + browsers both expose `btoa` on the global; we feed it
  // a binary string built from the byte view.
  let binary = '';
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function hmacSha256Base64(
  apiKey: string,
  payload: string,
): Promise<string> {
  const crypto = globalThis.crypto?.subtle;
  if (!crypto) {
    throw new SourceSignatureError(
      'source_signature_invalid',
      'WebCrypto HMAC support is unavailable in this runtime',
    );
  }
  const encoder = new TextEncoder();
  const key = await crypto.importKey(
    'raw',
    encoder.encode(apiKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bufferToBase64(
    await crypto.sign('HMAC', key, encoder.encode(payload)),
  );
}

/**
 * Constant-time string equality. Used over `===` so a malicious
 * signature can't be probed byte-by-byte via timing differences.
 */
function timingSafeEqual(expected: string, actual: string): boolean {
  const max = Math.max(expected.length, actual.length);
  let diff = expected.length ^ actual.length;
  for (let i = 0; i < max; i++) {
    diff |= (expected.charCodeAt(i) || 0) ^ (actual.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Sign a source request and return the headers to send with it. The signature
 * covers the message id, the timestamp, and the body, so any change to those
 * invalidates it. The receiver checks it with {@link verifyAbloSourceRequest}.
 */
export async function signAbloSourceRequest(
  options: SourceSignatureOptions,
): Promise<{
  readonly headers: Record<string, string>;
  readonly signedAt: number;
  readonly signature: string;
}> {
  const signedAt = options.timestamp ?? Math.floor(Date.now() / 1000);
  // Standard Webhooks signing input: `${msg_id}.${timestamp}.${payload}`
  const signature = await hmacSha256Base64(
    options.apiKey,
    `${options.messageId}.${signedAt}.${options.body}`,
  );
  return {
    signedAt,
    signature,
    headers: {
      [ABLO_SOURCE_HEADERS.id]: options.messageId,
      [ABLO_SOURCE_HEADERS.timestamp]: String(signedAt),
      [ABLO_SOURCE_HEADERS.signature]: `v1,${signature}`,
    },
  };
}

/**
 * Verify a signed source request, throwing {@link SourceSignatureError} when
 * the message id, timestamp, or signature is missing, malformed, or outside
 * the allowed clock-skew window. On success it returns the request's message
 * id and signing time. This is the counterpart to {@link signAbloSourceRequest}.
 */
export async function verifyAbloSourceRequest(
  options: SourceSignatureVerificationOptions,
): Promise<SourceSignatureVerificationResult> {
  const messageId = getHeader(options.request, ABLO_SOURCE_HEADERS.id);
  if (!messageId) {
    throw new SourceSignatureError(
      'source_id_missing',
      'Missing webhook-id header',
    );
  }

  const rawTimestamp = getHeader(options.request, ABLO_SOURCE_HEADERS.timestamp);
  if (!rawTimestamp) {
    throw new SourceSignatureError(
      'source_timestamp_missing',
      'Missing webhook-timestamp header',
    );
  }

  const signedAt = Number(rawTimestamp);
  if (!Number.isFinite(signedAt)) {
    throw new SourceSignatureError(
      'source_timestamp_invalid',
      'Invalid webhook-timestamp header',
    );
  }

  const toleranceMs = options.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const toleranceSeconds = Math.ceil(toleranceMs / 1000);
  if (Math.abs(nowSeconds - signedAt) > toleranceSeconds) {
    throw new SourceSignatureError(
      'source_timestamp_expired',
      'webhook-timestamp is outside the allowed clock-skew window',
    );
  }

  const presented = parseSignatureHeader(
    getHeader(options.request, ABLO_SOURCE_HEADERS.signature),
  );
  if (presented.length === 0) {
    throw new SourceSignatureError(
      'source_signature_missing',
      'Missing webhook-signature header',
    );
  }

  const expected = await hmacSha256Base64(
    options.apiKey,
    `${messageId}.${signedAt}.${options.body}`,
  );
  // Accept any presented signature that matches — supports key
  // rotation per the Standard Webhooks spec.
  const ok = presented.some((sig) => timingSafeEqual(expected, sig));
  if (!ok) {
    throw new SourceSignatureError(
      'source_signature_invalid',
      'Invalid webhook-signature',
    );
  }

  return { messageId, signedAt };
}
