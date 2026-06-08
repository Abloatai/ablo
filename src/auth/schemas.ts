import { z } from 'zod';
import { AbloAuthenticationError } from '../errors.js';

const AuthParticipantKindSchema = z.enum(['user', 'agent', 'system']);

export const AuthTokenSchema = z.string().trim().min(1);

export const CapabilityExchangeResponseSchema = z
  .object({
    capabilityId: z.string().min(1),
    token: AuthTokenSchema,
    expiresAt: z.string().min(1),
    organizationId: z.string().min(1),
    scope: z
      .object({
        organizationId: z.string().min(1),
        syncGroups: z.array(z.string()),
        operations: z.array(z.string()),
        participantKind: AuthParticipantKindSchema,
        participantId: z.string().min(1),
      })
      .passthrough(),
    userMeta: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type CapabilityExchangeResponse = z.infer<typeof CapabilityExchangeResponseSchema>;

export const IdentityResolveResponseSchema = z
  .object({
    participantKind: AuthParticipantKindSchema,
    participantId: z.string().min(1),
    accountScope: z.string().min(1),
    syncGroups: z.array(z.string()),
    userMeta: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export type IdentityResolveResponse = z.infer<typeof IdentityResolveResponseSchema>;

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
