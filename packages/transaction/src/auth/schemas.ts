import { z } from 'zod';
import { participantKindSchema } from '../coordination/schema.js';
import {
  capabilityMintResponseSchema,
  grantedOperationSchema,
  type CapabilityMintResponse,
} from './capability.js';
import { AbloAuthenticationError } from '../errors.js';
import { authTokenSchema } from './token.js';

// Not a second enum. The auth responses carry the same participant vocabulary
// the coordination plane parses, so they validate against the same schema — a
// kind the delta plane accepts must not throw here on an otherwise-valid
// identity-resolve response.
const AuthParticipantKindSchema = participantKindSchema;

export const IdentityResolveResponseSchema = z.object({
  participantKind: AuthParticipantKindSchema,
  participantId: z.string().min(1),
  accountScope: z.string().min(1),
  // The rest of the resolved plane. The server always emits these keys; null
  // means the credential does not bind that axis.
  projectId: z.string().min(1).nullable(),
  environment: z.enum(['sandbox', 'production']).nullable(),
  sandboxId: z.string().min(1).nullable(),
  syncGroups: z.array(z.string()),
  userMeta: z.record(z.string(), z.unknown()),
});

export type IdentityResolveResponse = z.infer<typeof IdentityResolveResponseSchema>;

/**
 * The response shape of `POST /v1/ephemeral_keys`, the endpoint that mints an
 * end-user session key (an `ek_` key). The shape is flat, with no nested scope
 * block. It still echoes the effective operations stored on the key so the
 * client reports enforced authority rather than reconstructing it from input.
 */
export const EphemeralKeyResponseSchema = z.object({
  object: z.literal('ephemeral_key').optional(),
  id: z.string().min(1),
  token: authTokenSchema,
  expiresAt: z.string().min(1),
  organizationId: z.string().min(1),
  participantId: z.string().min(1),
  syncGroups: z.array(z.string()),
  /** Effective operation grant stored on the credential. */
  operations: z.array(grantedOperationSchema).min(1),
});

export type EphemeralKeyResponse = z.infer<typeof EphemeralKeyResponseSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseCapabilityMintResponse(
  raw: unknown,
): CapabilityMintResponse {
  const parsed = capabilityMintResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AbloAuthenticationError(
      `apiKey exchange response was malformed: ${formatIssues(parsed.error)}`,
      { code: 'exchange_malformed_response', cause: parsed.error },
    );
  }
  return parsed.data;
}

export function parseEphemeralKeyResponse(raw: unknown): EphemeralKeyResponse {
  const parsed = EphemeralKeyResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AbloAuthenticationError(
      `user-session mint response was malformed: ${formatIssues(parsed.error)}`,
      { code: 'exchange_malformed_response', cause: parsed.error },
    );
  }
  return parsed.data;
}

export function parseIdentityResolveResponse(raw: unknown): IdentityResolveResponse {
  const parsed = IdentityResolveResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AbloAuthenticationError(
      `identity resolve response was malformed: ${formatIssues(parsed.error)}`,
      { code: 'identity_resolve_failed', cause: parsed.error },
    );
  }
  return parsed.data;
}
