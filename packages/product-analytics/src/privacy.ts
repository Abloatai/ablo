import { createHmac, timingSafeEqual } from 'node:crypto';

export const ANALYTICS_DIGEST_ALGORITHM = 'sha256' as const;

export const PROHIBITED_ANALYTICS_PROPERTY_KEYS = new Set([
  'apiKey',
  'code',
  'databaseUrl',
  'email',
  'error',
  'filename',
  'modelName',
  'path',
  'payload',
  'prompt',
  'rawError',
  'record',
  'schema',
  'sessionId',
  'sourceCode',
  'token',
  'workingDirectory',
]);

export interface AnalyticsDigestInput {
  identifier: string;
  key: string | Uint8Array;
  keyVersion: number;
}

export interface AnalyticsIdentifierDigest {
  digest: string;
  keyVersion: number;
}

export function digestAnalyticsIdentifier({
  identifier,
  key,
  keyVersion,
}: AnalyticsDigestInput): AnalyticsIdentifierDigest {
  if (identifier.length < 16 || identifier.length > 200) {
    throw new RangeError('analytics identifier must contain 16 to 200 characters');
  }
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new RangeError('analytics digest key version must be a positive integer');
  }
  const keyLength = typeof key === 'string' ? Buffer.byteLength(key, 'utf8') : key.byteLength;
  if (keyLength < 32) {
    throw new RangeError('analytics digest key must contain at least 32 bytes');
  }

  return {
    digest: createHmac(ANALYTICS_DIGEST_ALGORITHM, key)
      .update(identifier, 'utf8')
      .digest('base64url'),
    keyVersion,
  };
}

export function analyticsDigestsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'base64url');
  const rightBytes = Buffer.from(right, 'base64url');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function findProhibitedAnalyticsPropertyKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const prohibited = findProhibitedAnalyticsPropertyKey(item);
      if (prohibited) return prohibited;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;

  for (const [key, child] of Object.entries(value)) {
    if (PROHIBITED_ANALYTICS_PROPERTY_KEYS.has(key)) return key;
    const prohibited = findProhibitedAnalyticsPropertyKey(child);
    if (prohibited) return prohibited;
  }
  return null;
}
