/**
 * Canonical Ablo API-key format — the single source of truth for how keys
 * are minted, hashed, and validated. Both the sync-server (`apiKeyStore`)
 * and the web control-plane (`generate-key.ts`) consume THIS module, so the
 * format can no longer drift between the two mint sites (it used to live as
 * a hand-copied twin kept in sync by a comment).
 *
 * Node-only — uses `node:crypto`. Exposed via the `@abloatai/ablo/keys`
 * subpath and NEVER re-exported from the browser-facing `.` entry, so the
 * client bundle never pulls in `node:crypto`.
 *
 * Format (GitHub-style): `<sk|rk|ek>_<live|test>_<30 base62 body><6-char
 * base62 CRC32 checksum>`. The identifiable prefix + CRC32 checksum let
 * secret scanners detect leaks and let us reject typo'd/forged keys OFFLINE
 * (no DB round-trip). Legacy keys (a ~43-char base64url body, no checksum)
 * still validate by hash — they parse here as `checksummed: false`.
 */

import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// ── Vocabulary ──────────────────────────────────────────────────────────

// The Stripe-style key model:
//   secret (sk_)      — backend / server-to-server / agents. Full authority. Never in a browser.
//   restricted (rk_)  — scoped SERVER key (agent session tokens / capabilities).
//   ephemeral (ek_)   — short-lived, backend-minted, USER-scoped BROWSER session credential
//                       (Stripe ephemeral keys). Carries participantKind:'user' + baked syncGroups.
//   publishable (pk_) — long-lived, browser-safe, org-scoped, READ-ONLY project key
//                       (Stripe `pk_` / Supabase anon key). Used DIRECTLY as the bearer
//                       (never exchanged, never expires → nothing to refresh). The org owns
//                       it; it grants read access to the org's data plane and cannot write
//                       or reach any control-plane operation.
export const API_KEY_KINDS = ['secret', 'restricted', 'ephemeral', 'publishable'] as const;
export type ApiKeyKind = (typeof API_KEY_KINDS)[number];

export const API_KEY_ENVS = ['live', 'test'] as const;
export type ApiKeyEnv = (typeof API_KEY_ENVS)[number];

const PREFIX_BY_KIND: Record<ApiKeyKind, string> = {
  secret: 'sk',
  restricted: 'rk',
  ephemeral: 'ek',
  publishable: 'pk',
};
const KIND_BY_PREFIX: Record<string, ApiKeyKind> = {
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

/** `<sk|rk|ek|pk>_<live|test>_<body>`; body charset covers base62 AND legacy base64url. */
const KEY_RE = /^(sk|rk|ek|pk)_(live|test)_([0-9A-Za-z\-_]+)$/;
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
    c = (CRC32_TABLE[(c ^ s.charCodeAt(i)) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** 6-char base62 encoding of the CRC32 of `payload`. */
function checksum6(payload: string): string {
  let n = crc32(payload);
  let out = '';
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    out = BASE62[n % 62] + out;
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
        out += BASE62[b % 62];
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
  env: ApiKeyEnv;
  /** The chars after `<prefix>_<env>_` (body + checksum for new keys). */
  body: string;
  /** True when this is the new checksummed format (36-char base62 body). */
  checksummed: boolean;
}

function bodyIsChecksummed(body: string): boolean {
  return body.length === CHECKSUMMED_BODY_LEN && BASE62_RE.test(body);
}

/**
 * Canonical schema for an Ablo API key. `parse`/`safeParse` returns a typed
 * {@link ParsedApiKey}; a new checksummed-format key with a BAD checksum is
 * rejected (the offline-reject), while a legacy key parses as
 * `checksummed: false` and passes (the server still hash-validates it).
 */
export const apiKeySchema = z.string().transform((raw, ctx): ParsedApiKey => {
  const m = KEY_RE.exec(raw);
  if (!m) {
    ctx.addIssue({ code: 'custom', message: 'not a valid Ablo API key format' });
    return z.NEVER;
  }
  const [, prefix, env, body] = m;
  const checksummed = bodyIsChecksummed(body);
  if (checksummed && checksum6(raw.slice(0, -CHECKSUM_LEN)) !== body.slice(KEY_BODY_LEN)) {
    ctx.addIssue({ code: 'custom', message: 'API key checksum mismatch' });
    return z.NEVER;
  }
  return { raw, kind: KIND_BY_PREFIX[prefix], env: env as ApiKeyEnv, body, checksummed };
});

// ── Derived validators (thin wrappers over the same spec) ───────────────

/** Parse + fully validate (incl. checksum). Returns null when invalid. */
export function parseApiKey(raw: string): ParsedApiKey | null {
  const r = apiKeySchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** True when the key uses the new checksummed format (regardless of validity). */
export function isChecksummedKey(raw: string): boolean {
  const m = KEY_RE.exec(raw);
  return m !== null && bodyIsChecksummed(m[3]);
}

/** Verify the embedded checksum. Meaningful only for checksummed-format keys. */
export function keyChecksumMatches(raw: string): boolean {
  const m = KEY_RE.exec(raw);
  if (!m || !bodyIsChecksummed(m[3])) return false;
  return checksum6(raw.slice(0, -CHECKSUM_LEN)) === m[3].slice(KEY_BODY_LEN);
}

// ── Mint + hash (node:crypto) ───────────────────────────────────────────

/**
 * Mint a key: `<prefix>_<env>_<body><checksum>`. Returns the plaintext (shown
 * once), its SHA-256 hash (persisted), and the 12-char display prefix.
 */
export function generateApiKey(
  env: ApiKeyEnv = 'live',
  kind: ApiKeyKind = 'secret',
): { plaintext: string; hash: string; prefix: string } {
  const body = randomBase62(KEY_BODY_LEN);
  const payload = `${PREFIX_BY_KIND[kind]}_${env}_${body}`;
  const plaintext = `${payload}${checksum6(payload)}`;
  return { plaintext, hash: hashApiKey(plaintext), prefix: plaintext.slice(0, 12) };
}

/**
 * Stable SHA-256 hex of a plaintext key. A fast hash is CORRECT here (not
 * bcrypt) — API keys are high-entropy random, so there's no dictionary to
 * defend against. Used at both write (mint) and lookup.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** `whsec_` label prefix per the Standard Webhooks spec (not part of the key material). */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/**
 * Mint a webhook signing secret per the Standard Webhooks spec
 * (https://www.standardwebhooks.com): a base64-encoded random key, 24–64 bytes,
 * labelled with the `whsec_` prefix. We use 32 bytes (256 bits) — comfortably
 * inside the range and matching Stripe/Svix. Unlike an API key this is NOT
 * hashed at rest: signing (`signAbloSourceRequest`) needs the live key, so it is
 * stored by reference via the secret store, returned to the customer once at
 * creation, and never echoed again (Stripe's policy).
 */
export function generateWebhookSecret(): { plaintext: string; last4: string } {
  const plaintext = `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64')}`;
  return { plaintext, last4: plaintext.slice(-4) };
}
