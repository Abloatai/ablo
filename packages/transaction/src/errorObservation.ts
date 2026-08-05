import { z } from 'zod';

export const errorObservationSeveritySchema = z.enum([
  'debug', 'info', 'warning', 'error', 'fatal',
]);

export const errorObservationChannelSchema = z.enum([
  'http', 'websocket', 'connector', 'background', 'process', 'cli', 'browser',
]);

const TRUNCATION_MARKER = '…[truncated]';

/**
 * Keep an observation field inside its wire bound without dropping the event.
 * This lives beside the schema so producers cannot accidentally enforce a
 * different limit. Redaction still happens before parsing at each boundary.
 */
export function boundObservationString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

const boundedString = (maxLength: number) =>
  z.preprocess(
    (value) => typeof value === 'string' ? boundObservationString(value, maxLength) : value,
    z.string().max(maxLength),
  );

const boundedCauseSchema = z.object({
  type: boundedString(200),
  message: boundedString(2_000),
});

/** Runtime-neutral private event vocabulary shared by every error boundary. */
export const errorObservationSchema = z.object({
  eventId: boundedString(200).pipe(z.string().min(1)),
  occurredAt: z.iso.datetime(),
  service: boundedString(100).pipe(z.string().min(1)),
  stage: boundedString(100).pipe(z.string().min(1)),
  release: boundedString(200).optional(),
  severity: errorObservationSeveritySchema,
  channel: errorObservationChannelSchema,
  scope: boundedString(200).pipe(z.string().min(1)),
  operation: boundedString(300).pipe(z.string().min(1)),
  errorCode: boundedString(200).pipe(z.string().min(1)),
  errorType: boundedString(200).pipe(z.string().min(1)),
  category: boundedString(100).pipe(z.string().min(1)),
  retryable: z.boolean(),
  /** Whether application code converted the failure into an expected outcome. */
  handled: z.boolean(),
  publicMessage: boundedString(2_000),
  internalMessage: boundedString(4_000).optional(),
  stack: boundedString(20_000).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  requestId: boundedString(200).optional(),
  traceId: boundedString(200).optional(),
  spanId: boundedString(200).optional(),
  organizationId: boundedString(200).optional(),
  projectId: boundedString(200).optional(),
  branchId: boundedString(200).optional(),
  keyKind: boundedString(100).optional(),
  storageKind: boundedString(100).optional(),
  storageTransport: boundedString(100).optional(),
  dataSourceId: boundedString(200).optional(),
  connectorState: boundedString(100).optional(),
  model: boundedString(200).optional(),
  cause: z.array(boundedCauseSchema).max(5).optional(),
  diagnosticContext: z.record(z.string(), z.unknown()).optional(),
});

export type ErrorObservation = Readonly<z.infer<typeof errorObservationSchema>>;
export type ErrorObservationChannel = z.infer<typeof errorObservationChannelSchema>;
export type ErrorObservationSeverity = z.infer<typeof errorObservationSeveritySchema>;

const SENSITIVE_KEYS = [
  'password', 'secret', 'token', 'apikey', 'authorization', 'cookie',
  'databaseurl', 'connectionstring', 'ek', 'sk', 'rk', 'body', 'payload', 'sql', 'query',
];
const MASK = '[redacted]';
const SECRET_PATTERNS = [
  /postgres(?:ql)?:\/\/[^\s"']+/gi,
  /\b[a-z]{2,4}_[A-Za-z0-9]{12,}\b/g,
];

export function redactObservationString(value: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, MASK), value);
}

function isSensitiveObservationKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_KEYS.some(
    (sensitive) => normalized === sensitive || (sensitive.length > 3 && normalized.includes(sensitive)),
  );
}

/** Runtime-neutral, circular-safe sanitizer used before any observation sink. */
export function sanitizeObservationValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet(),
): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactObservationString(value);
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeObservationValue(item, depth + 1, seen));
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = isSensitiveObservationKey(key)
        ? MASK
        : sanitizeObservationValue(item, depth + 1, seen);
    }
    return sanitized;
  }
  return value;
}
