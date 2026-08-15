import { z } from 'zod';
import { stableStringify } from '../utils/json.js';

/** Bump only with a coordinated MAC-message protocol rollout. */
export const SESSION_ISSUANCE_MAC_VERSION = 'v1' as const;
/** Bump whenever canonical mint semantics change incompatibly. */
export const SESSION_ISSUANCE_SLOT_VERSION = 'v1' as const;

export const SESSION_ISSUANCE_PATHS = {
  mint: '/api/v1/ephemeral_keys',
  revoke: '/api/v1/internal/session-credentials/revoke',
} as const;

export const SESSION_ISSUANCE_HEADERS = {
  slotKey: 'ablo-session-slot',
  parentSessionHash: 'ablo-parent-session',
  timestamp: 'ablo-session-issuance-timestamp',
  mac: 'ablo-session-issuance-mac',
} as const;

export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const opaqueSessionFingerprintSchema = sha256HexSchema;

export const sessionIssuanceMacHeadersSchema = z.object({
  timestamp: z.string().regex(/^\d{13}$/),
  mac: sha256HexSchema,
});
export type SessionIssuanceMacHeaders = z.infer<typeof sessionIssuanceMacHeadersSchema>;

export const sessionIssuanceMacMessageSchema = z.object({
  method: z.enum(['POST']),
  path: z.enum([SESSION_ISSUANCE_PATHS.mint, SESSION_ISSUANCE_PATHS.revoke]),
  timestamp: z.string().regex(/^\d{13}$/),
  bodySha256: sha256HexSchema,
  slotKey: opaqueSessionFingerprintSchema.optional(),
  parentSessionHash: opaqueSessionFingerprintSchema,
});
export type SessionIssuanceMacMessage = z.infer<typeof sessionIssuanceMacMessageSchema>;

/** One canonical JSON representation for slot derivation and request MACs. */
export function canonicalizeSessionIssuanceBody(body: unknown): string {
  return stableStringify(body);
}

/** Canonical, bounded KMS GenerateMac/VerifyMac message (well below 4 KiB). */
export function buildSessionIssuanceMacMessage(input: SessionIssuanceMacMessage): Uint8Array {
  const value = sessionIssuanceMacMessageSchema.parse(input);
  return new TextEncoder().encode([
    `ablo-session-issuance:${SESSION_ISSUANCE_MAC_VERSION}`,
    value.method,
    value.path,
    value.timestamp,
    value.bodySha256,
    value.slotKey ?? '',
    value.parentSessionHash,
  ].join('\n'));
}
