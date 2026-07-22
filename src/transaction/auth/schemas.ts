import { z } from 'zod';
import { participantKindSchema } from '../coordination/schema.js';
import { capabilityScopeSchema } from './capability.js';
import { AbloAuthenticationError } from '../errors.js';

// Not a second enum. The auth responses carry the same participant vocabulary
// the coordination plane parses, so they validate against the same schema — a
// kind the delta plane accepts must not throw here on an otherwise-valid
// identity-resolve response.
const AuthParticipantKindSchema = participantKindSchema;

export const AuthTokenSchema = z.string().trim().min(1);

export const CapabilityExchangeResponseSchema = z
  .object({
    capabilityId: z.string().min(1),
    token: AuthTokenSchema,
    expiresAt: z.string().min(1),
    organizationId: z.string().min(1),
    // The grant the mint settled on, in the one shape the key row stores and
    // the gates read — not a second description of it.
    scope: capabilityScopeSchema.loose(),
    userMeta: z.record(z.string(), z.unknown()),
  })
  .loose();

export type CapabilityExchangeResponse = z.infer<typeof CapabilityExchangeResponseSchema>;

export const IdentityResolveResponseSchema = z
  .object({
    participantKind: AuthParticipantKindSchema,
    participantId: z.string().min(1),
    accountScope: z.string().min(1),
    // The rest of the plane this credential resolves to. `nullish` (optional +
    // nullable) so a server too old to send them still parses, and a human
    // session — which carries no such scope — validates with them absent.
    // `projectId` equals the org id for the org-default project.
    projectId: z.string().min(1).nullish(),
    environment: z.enum(['sandbox', 'production']).nullish(),
    sandboxId: z.string().min(1).nullish(),
    syncGroups: z.array(z.string()),
    userMeta: z.record(z.string(), z.unknown()),
  })
  .loose();

export type IdentityResolveResponse = z.infer<typeof IdentityResolveResponseSchema>;

/**
 * The response shape of `POST /auth/ephemeral-keys`, the endpoint that mints an
 * end-user session key (an `ek_` key). The shape is flat, with no nested scope
 * block: the server records the scope on the key itself and re-derives it on
 * every request, so the client only needs the token and identity fields to hand
 * to the browser.
 */
export const EphemeralKeyResponseSchema = z
  .object({
    object: z.literal('ephemeral_key').optional(),
    id: z.string().min(1),
    token: AuthTokenSchema,
    expiresAt: z.string().min(1),
    organizationId: z.string().min(1),
    participantId: z.string().min(1),
    syncGroups: z.array(z.string()),
  })
  .loose();

export type EphemeralKeyResponse = z.infer<typeof EphemeralKeyResponseSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export function parseCapabilityExchangeResponse(
  raw: unknown,
): CapabilityExchangeResponse {
  const parsed = CapabilityExchangeResponseSchema.safeParse(raw);
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
