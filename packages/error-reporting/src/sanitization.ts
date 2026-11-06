/**
 * Shared telemetry sanitization utilities.
 *
 * Single source of truth for sensitive key lists and sanitization logic,
 * used by application log and error-reporting transports,
 * instrumentation-client.ts, and error-reporting.ts.
 *
 * NOT marked 'use client' — this module must be importable from all runtimes
 * (server, client, edge).
 */
// ── Single source of truth for sensitive field names ──────────────────────────
// Covers auth tokens, PII, and financial data (SOC 2 / investment banking context)
export const SENSITIVE_KEYS: readonly string[] = [
  // Auth & credentials
  'password',
  'token',
  'api_key',
  'apikey',
  'secret',
  'private_key',
  'authorization',
  'auth',
  'credential',
  'auth_token',
  // Infrastructure
  'database_url',
  'redis_url',
  'connection_string',
  // PII
  'ssn',
  'social_security',
  // Financial
  'account_number',
  'routing_number',
  'credit_card',
  'bank_account',
  'swift_code',
  'iban',
  'salary',
  'revenue',
  'valuation',
  'financial_data',
] as const;

// Headers that must always be redacted
const SENSITIVE_HEADER_PATTERNS = ['authorization', 'cookie', 'token', 'api-key'];

// Query param keys that must be redacted
const SENSITIVE_QUERY_PARAMS = ['api_key', 'token', 'password', 'secret'];

// ── Type-safe helpers ─────────────────────────────────────────────────────────

/**
 * Recursively mask values whose keys match any sensitive pattern.
 * Handles nested objects and arrays without changing the original input.
 */
export function maskSensitiveFields(
  obj: Record<string, unknown>,
  keys: readonly string[] = SENSITIVE_KEYS
): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...obj };

  for (const key of Object.keys(masked)) {
    const lowerKey = key.toLowerCase();

    if (keys.some((sensitive) => lowerKey.includes(sensitive))) {
      masked[key] = '[REDACTED]';
    } else {
      masked[key] = maskSensitiveValue(masked[key], keys);
    }
  }

  return masked;
}

function maskSensitiveValue(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskSensitiveValue(item, keys));
  }
  return value !== null && typeof value === 'object'
    ? maskSensitiveFields(value as Record<string, unknown>, keys)
    : value;
}

/**
 * Sanitize HTTP request headers, redacting auth/cookie/token headers.
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized = { ...headers };
  for (const key of Object.keys(sanitized)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADER_PATTERNS.some((pattern) => lowerKey.includes(pattern))) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
}

/**
 * Sanitize a URL query string, redacting sensitive parameter values.
 */
export function sanitizeQueryString(queryString: string): string {
  return queryString
    .split('&')
    .map((param) => {
      const eqIndex = param.indexOf('=');
      if (eqIndex === -1) return param;
      const key = param.slice(0, eqIndex);
      if (SENSITIVE_QUERY_PARAMS.some((sensitive) => key.toLowerCase().includes(sensitive))) {
        return `${key}=[REDACTED]`;
      }
      return param;
    })
    .join('&');
}

/**
 * Mask an email address for privacy (e.g. "jo***@example.com").
 */
export function maskEmail(email: string): string {
  const [username, domain] = email.split('@');
  if (!username || !domain) return '[REDACTED]';
  const maskedUsername =
    username.length > 2 ? username.slice(0, 2) + '*'.repeat(username.length - 2) : '**';
  return `${maskedUsername}@${domain}`;
}
