/**
 * The Ablo API-key format: how keys are minted, hashed, and validated, in one
 * place so every component that issues or checks a key agrees on the format.
 *
 * This module uses `node:crypto` and is therefore Node-only. It is published on
 * the `@abloatai/transaction/keys` subpath and kept off the main browser-facing entry
 * so a browser bundle never pulls in `node:crypto`.
 *
 * A data-plane key looks like
 * `<sk|rk|ek|pk>_<30 base62 chars><6-char base62 CRC32 checksum>`.
 * A control-plane management key is `mk_<body><checksum>`. A key's project and
 * branch are server-side bindings, not claims encoded in the plaintext. The recognizable prefix lets secret
 * scanners spot a leaked key, and the trailing checksum lets the format reject a
 * mistyped or forged key locally, without a database round-trip. Older
 * `<kind>_<live|test>_…` keys remain valid compatibility inputs and expose their
 * legacy environment hint when parsed.
 */

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  KEY_ENVIRONMENTS,
  KEY_PREFIX_ENVIRONMENTS,
  environmentFromKeyPrefix,
  type KeyEnvironment,
  type KeyPrefixEnvironment,
} from '../environment.js';

// ── Vocabulary ──────────────────────────────────────────────────────────

// The five credential kinds:
//   management (mk_)  — project control-plane authority. It can manage projects
//                       and branches and mint leaf branch credentials, but has
//                       no data-plane read/write authority and no livemode.
//   secret (sk_)      — backend and server-to-server use, including agents. Full
//                       authority; never expose one in a browser.
//   restricted (rk_)  — a scoped server key, such as an agent session token or a
//                       narrowed capability.
//   ephemeral (ek_)   — a short-lived, backend-minted session credential scoped to
//                       one user, safe to hand to that user's browser. Carries
//                       `participantKind: 'user'` and its baked-in sync groups.
//   publishable (pk_) — a long-lived, browser-safe, organization-scoped read-only
//                       key. It is used directly as the bearer token — never
//                       exchanged, never expires, nothing to refresh. It grants
//                       read access to the organization's data and cannot write or
//                       reach any control-plane operation.
export const API_KEY_KINDS = [
  'management',
  'secret',
  'restricted',
  'ephemeral',
  'publishable',
] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

// Retained as a compatibility vocabulary for old keys and APIs. New keys do not
// encode an environment: the key row's branch binding is authoritative.
export const API_KEY_ENVS = KEY_ENVIRONMENTS;
export type ApiKeyEnv = KeyEnvironment;

const PREFIX_BY_KIND: Record<ApiKeyKind, string> = {
  management: 'mk',
  secret: 'sk',
  restricted: 'rk',
  ephemeral: 'ek',
  publishable: 'pk',
};
const KIND_BY_PREFIX: Record<string, ApiKeyKind> = {
  mk: 'management',
  sk: 'secret',
  rk: 'restricted',
  ek: 'ephemeral',
  pk: 'publishable',
};

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Random base62 chars before the checksum. */
const KEY_BODY_LEN = 30;
/** base62(CRC32): 62^6 (~5.7e10) > 2^32, so a CRC32 always fits in 6 chars. */
const CHECKSUM_LEN = 6;
/** A new checksummed body is exactly this long and pure base62. */
const CHECKSUMMED_BODY_LEN = KEY_BODY_LEN + CHECKSUM_LEN;

/** Current `<sk|rk|ek|pk>_<body>` spelling. */
const DATA_KEY_RE = /^(sk|rk|ek|pk)_([0-9A-Za-z\-_]+)$/;
/** Compatibility spelling used before branches became the routing boundary. */
const LEGACY_DATA_KEY_RE = /^(sk|rk|ek|pk)_(live|test)_([0-9A-Za-z\-_]+)$/;
/** `mk_<body>`; management credentials have no data livemode segment. */
const MANAGEMENT_KEY_RE = /^(mk)_([0-9A-Za-z\-_]+)$/;
const BASE62_RE = /^[0-9A-Za-z]+$/;

// ── Checksum (standard CRC-32, GitHub-compatible) ───────────────────────

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) {
    // `& 0xff` bounds the index to the 256-entry table — the ?? 0 is unreachable.
    c = ((CRC32_TABLE[(c ^ s.charCodeAt(i)) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 6-char base62 encoding of the CRC32 of `payload`. */
function checksum6(payload: string): string {
  let n = crc32(payload);
  let out = '';
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    out = BASE62.charAt(n % 62) + out;
    n = Math.floor(n / 62);
  }
  return out;
}

/** `len` cryptographically-random base62 chars (rejection-sampled, no bias). */
function randomBase62(len: number): string {
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248) {
        out += BASE62.charAt(b % 62);
        if (out.length === len) break;
      }
    }
  }
  return out;
}

// ── Zod schema (the executable spec) ────────────────────────────────────

/** A structurally-valid Ablo API key, parsed into its parts. */
export interface ParsedApiKey {
  /** The original plaintext. */
  raw: string;
  kind: ApiKeyKind;
  /** Legacy hint for old `_live_`/`_test_` keys; null for all current keys. */
  env: ApiKeyEnv | null;
  /** The random body + checksum after the recognizable prefix. */
  body: string;
  /** True when this is the new checksummed format (36-char base62 body). */
  checksummed: boolean;
}

function bodyIsChecksummed(body: string): boolean {
  return body.length === CHECKSUMMED_BODY_LEN && BASE62_RE.test(body);
}

/**
 * The Zod schema for an Ablo API key. `parse` and `safeParse` return a typed
 * {@link ParsedApiKey}. A checksummed-format key whose checksum does not match is
 * rejected without any network call; an older key with no checksum parses with
 * `checksummed: false` and is left for the server to validate by hash.
 */
export const apiKeySchema = z.string().transform((raw, ctx): ParsedApiKey => {
  const legacyDataMatch = LEGACY_DATA_KEY_RE.exec(raw);
  const dataMatch = legacyDataMatch ? null : DATA_KEY_RE.exec(raw);
  const managementMatch = MANAGEMENT_KEY_RE.exec(raw);
  if (!legacyDataMatch && !dataMatch && !managementMatch) {
    ctx.addIssue({ code: 'custom', message: 'not a valid Ablo API key format' });
    return z.NEVER;
  }
  const prefix = legacyDataMatch?.[1] ?? dataMatch?.[1] ?? managementMatch?.[1];
  const env = legacyDataMatch?.[2];
  const body = legacyDataMatch?.[3] ?? dataMatch?.[2] ?? managementMatch?.[2];
  const kind = prefix === undefined ? undefined : KIND_BY_PREFIX[prefix];
  // Unreachable on a KEY_RE match (all three groups are non-optional and the
  // prefix alternation is exactly the KIND_BY_PREFIX key set) — narrows the
  // regex-group lookups for the checks below.
  if (kind === undefined || body === undefined) {
    ctx.addIssue({ code: 'custom', message: 'not a valid Ablo API key format' });
    return z.NEVER;
  }
  const checksummed = bodyIsChecksummed(body);
  if (checksummed && checksum6(raw.slice(0, -CHECKSUM_LEN)) !== body.slice(KEY_BODY_LEN)) {
    ctx.addIssue({ code: 'custom', message: 'API key checksum mismatch' });
    return z.NEVER;
  }
  return {
    raw,
    kind,
    env:
      env === undefined ? null : environmentFromKeyPrefix(env as KeyPrefixEnvironment),
    body,
    checksummed,
  };
});

// ── Derived validators (thin wrappers over the same spec) ───────────────

/** Parse + fully validate (incl. checksum). Returns null when invalid. */
export function parseApiKey(raw: string): ParsedApiKey | null {
  const r = apiKeySchema.safeParse(raw);
  return r.success ? r.data : null;
}

/**
 * Read the environment off a STORED display prefix (`keyPrefix`, the first 12
 * chars — `rk_test_abcd`), rather than off a full plaintext key.
 *
 * Current keys return null because routing comes from their persisted branch.
 * This helper exists only while stored legacy prefixes remain in circulation.
 */
export function environmentFromStoredKeyPrefix(prefix: string): KeyEnvironment | null {
  const spelling = /^(?:sk|rk|ek|pk)_([a-z]+)_/.exec(prefix)?.[1];
  const env = KEY_PREFIX_ENVIRONMENTS.find((candidate) => candidate === spelling);
  return env === undefined ? null : environmentFromKeyPrefix(env);
}

/** True when the key uses the new checksummed format (regardless of validity). */
export function isChecksummedKey(raw: string): boolean {
  const body =
    LEGACY_DATA_KEY_RE.exec(raw)?.[3] ??
    DATA_KEY_RE.exec(raw)?.[2] ??
    MANAGEMENT_KEY_RE.exec(raw)?.[2];
  return body !== undefined && bodyIsChecksummed(body);
}

/** Verify the embedded checksum. Meaningful only for checksummed-format keys. */
export function keyChecksumMatches(raw: string): boolean {
  const body =
    LEGACY_DATA_KEY_RE.exec(raw)?.[3] ??
    DATA_KEY_RE.exec(raw)?.[2] ??
    MANAGEMENT_KEY_RE.exec(raw)?.[2];
  if (body === undefined || !bodyIsChecksummed(body)) return false;
  return checksum6(raw.slice(0, -CHECKSUM_LEN)) === body.slice(KEY_BODY_LEN);
}

// ── Mint + hash (node:crypto) ───────────────────────────────────────────

/**
 * Mint a branch-bound key: `<prefix>_<body><checksum>`. Returns the plaintext
 * (shown once), its SHA-256 hash (persisted), and the 12-char display prefix.
 *
 * `env` remains in the signature so older callers can upgrade independently,
 * but it no longer changes the plaintext. The persisted branch binding decides
 * where the key acts.
 */
export function generateApiKey(
  env: ApiKeyEnv | null = null,
  kind: ApiKeyKind = 'secret',
): { plaintext: string; hash: string; prefix: string } {
  const body = randomBase62(KEY_BODY_LEN);
  void env;
  const payload = `${PREFIX_BY_KIND[kind]}_${body}`;
  const plaintext = `${payload}${checksum6(payload)}`;
  return { plaintext, hash: hashApiKey(plaintext), prefix: plaintext.slice(0, 12) };
}

/** Mint a project-scoped, control-plane-only credential. */
export function generateManagementKey(): {
  plaintext: string;
  hash: string;
  prefix: string;
} {
  return generateApiKey(null, 'management');
}

/**
 * The stable SHA-256 hex digest of a plaintext key, computed both when a key is
 * minted and when one is looked up. A fast hash is the right choice here rather
 * than a password hash like bcrypt: API keys are long random strings, so there is
 * no dictionary of guesses to slow down.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** `whsec_` label prefix per the Standard Webhooks spec (not part of the key material). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * Mints a webhook signing secret following the Standard Webhooks specification
 * (https://www.standardwebhooks.com): a base64-encoded random key of 24–64 bytes,
 * labelled with the `whsec_` prefix. This uses 32 bytes (256 bits), comfortably
 * inside that range. Unlike an API key, a signing secret is not hashed at rest,
 * because signing a request with {@link signAbloSourceRequest} needs the live
 * value. It is therefore kept in a secret store, returned to the customer once at
 * creation, and never shown again.
 */
export function generateWebhookSecret(): { plaintext: string; last4: string } {
  const plaintext = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
  return { plaintext, last4: plaintext.slice(-4) };
}
