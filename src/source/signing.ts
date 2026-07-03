/**
 * Standard Webhooks request signing/verification for Data Source calls.
 *
 * Ablo signs every outbound source request with the customer's project API
 * key; the customer's endpoint verifies before any handler runs. Both halves
 * live in this leaf so `pushQueue.ts` (customer-side sender) and `factory.ts`
 * (customer-side receiver) can import them directly without a runtime cycle
 * through the `index.ts` barrel.
 */

export interface SourceSignatureOptions {
  readonly apiKey: string;
  readonly body: string;
  /**
   * Unique message id (`webhook-id` per the Standard Webhooks spec).
   * Required: it goes into the HMAC input for replay defense, and
   * receivers may dedupe by it.
   */
  readonly messageId: string;
  /**
   * Unix timestamp in seconds. Defaults to the current time.
   */
  readonly timestamp?: number;
}

export interface SourceSignatureVerificationOptions {
  readonly request: Request;
  readonly body: string;
  readonly apiKey: string;
  readonly toleranceMs?: number;
}

export interface SourceSignatureVerificationResult {
  readonly messageId: string;
  readonly signedAt: number;
}

/**
 * HTTP headers used on signed source requests. Conforms to the
 * Standard Webhooks specification (https://www.standardwebhooks.com/)
 * so customer code can verify our signatures with any of the official
 * libraries (svix, standardwebhooks, hookdeck, etc.) — no Ablo-
 * specific verifier required.
 */
export const ABLO_SOURCE_HEADERS = {
  signature: 'webhook-signature',
  timestamp: 'webhook-timestamp',
  id: 'webhook-id',
  idempotencyKey: 'Idempotency-Key',
} as const;

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

function getHeader(request: Request, name: string): string | null {
  const headers = request.headers as
    | Headers
    | Record<string, string | undefined>
    | undefined;
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
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

// ── DataSource* naming aliases (kept 1:1 with the Source* names above; any
// deprecation of one naming family is a separate decision) ──
export type DataSourceSignatureOptions = SourceSignatureOptions;
export type DataSourceSignatureVerificationOptions =
  SourceSignatureVerificationOptions;
export type DataSourceSignatureVerificationResult =
  SourceSignatureVerificationResult;
