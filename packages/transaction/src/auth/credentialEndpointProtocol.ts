import { z } from 'zod';
import { classifyCredentialKind } from './credentialKind.js';

export const credentialEndpointKindSchema = z.enum([
  'ephemeral',
  'restricted',
]);

export const credentialEndpointSuccessSchema = z.strictObject({
  token: z.string().trim().min(1),
  expiresAt: z.iso.datetime({ offset: true }),
  credentialKind: credentialEndpointKindSchema,
});

export const credentialEndpointErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().optional(),
  }),
});

export type CredentialEndpointSuccess = z.infer<
  typeof credentialEndpointSuccessSchema
>;
export type CredentialEndpointError = z.infer<
  typeof credentialEndpointErrorSchema
>;

export function parseCredentialEndpointSuccess(
  raw: unknown,
): CredentialEndpointSuccess {
  const parsed = credentialEndpointSuccessSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `credential endpoint returned a malformed success body: ${z.prettifyError(parsed.error)}`,
    );
  }
  const actualKind = classifyCredentialKind(parsed.data.token);
  if (actualKind !== parsed.data.credentialKind) {
    throw new Error(
      `credential endpoint declared ${parsed.data.credentialKind} but returned ` +
        `${actualKind ?? 'an unknown credential kind'}`,
    );
  }
  return parsed.data;
}

export function credentialEndpointErrorCode(raw: unknown): string | null {
  const parsed = credentialEndpointErrorSchema.safeParse(raw);
  return parsed.success ? parsed.data.error.code : null;
}
