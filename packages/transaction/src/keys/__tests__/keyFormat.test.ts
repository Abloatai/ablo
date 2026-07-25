/**
 * Canonical key-format module — the Zod schema is the executable spec; the
 * standalone validators are derived from the same constants. Both the
 * sync-server store and the web control-plane mint via this module, so these
 * tests pin the shared contract.
 */

// This package runs jest — a `from 'vitest'` import here fails the whole
// suite ("Vitest cannot be imported in a CommonJS module").
import { describe, it, expect } from '@jest/globals';
import {
  apiKeySchema,
  parseApiKey,
  generateApiKey,
  hashApiKey,
  isChecksummedKey,
  keyChecksumMatches,
  API_KEY_KINDS,
  API_KEY_ENVS,
  type ApiKeyKind,
} from '@abloatai/transaction/keys';

describe('apiKeySchema (Zod-modeled key format)', () => {
  it('parses a minted key into typed parts', () => {
    const { plaintext } = generateApiKey('production', 'restricted');
    const parsed = apiKeySchema.parse(plaintext);
    expect(parsed).toMatchObject({ raw: plaintext, kind: 'restricted', env: 'production', checksummed: true });
    expect(parsed.body.length).toBe(36);
  });

  it('mints the right prefix for every kind/env and self-validates', () => {
    const expected: Record<ApiKeyKind, string> = {
      secret: 'sk',
      restricted: 'rk',
      ephemeral: 'ek',
      publishable: 'pk',
    };
    for (const kind of API_KEY_KINDS) {
      for (const env of API_KEY_ENVS) {
        const { plaintext, prefix } = generateApiKey(env, kind);
        const prefixEnv = env === 'sandbox' ? 'test' : 'live';
        expect(plaintext.startsWith(`${expected[kind]}_${prefixEnv}_`)).toBe(true);
        expect(prefix.length).toBe(12);
        expect(keyChecksumMatches(plaintext)).toBe(true);
        expect(parseApiKey(plaintext)).not.toBeNull();
      }
    }
  });

  it('rejects a tampered body and a tampered checksum (offline)', () => {
    const { plaintext } = generateApiKey('sandbox', 'secret');
    const bodyFlip =
      plaintext.slice(0, 11) + (plaintext[11] === 'A' ? 'B' : 'A') + plaintext.slice(12);
    const sumFlip = plaintext.slice(0, -1) + (plaintext.at(-1) === 'A' ? 'B' : 'A');
    expect(parseApiKey(bodyFlip)).toBeNull();
    expect(parseApiKey(sumFlip)).toBeNull();
    expect(apiKeySchema.safeParse(sumFlip).success).toBe(false);
  });

  it('accepts a legacy base64url key as checksummed:false (back-compat)', () => {
    const legacy = 'sk_live_' + 'a'.repeat(43); // old format: no checksum
    const parsed = parseApiKey(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.checksummed).toBe(false);
    expect(isChecksummedKey(legacy)).toBe(false);
  });

  it('rejects non-keys and unknown prefixes', () => {
    expect(parseApiKey('not-a-key')).toBeNull();
    expect(parseApiKey('xx_live_' + 'a'.repeat(36))).toBeNull();
    expect(isChecksummedKey('xx_live_' + 'a'.repeat(36))).toBe(false);
  });

  it('hashApiKey is a stable SHA-256 hex', () => {
    const h = hashApiKey('sk_live_abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey('sk_live_abc')).toBe(h);
  });
});
