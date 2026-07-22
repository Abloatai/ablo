/**
 * The request body for minting a session credential.
 *
 * `POST /v1/ephemeral_keys` is the first call any caller makes — nothing else in
 * the API is reachable without the credential it returns. That makes it the one
 * route a published contract cannot omit, so its shape lives here beside the
 * rest of the boundary rather than being read field-by-field out of the handler.
 *
 * The response side already had a home: `EphemeralKeyResponseSchema` in
 * `auth/schemas.ts`.
 */

import { z } from 'zod';

/** The participant this session acts as. */
export const ephemeralKeyUserSchema = z.object({
  id: z.string().min(1),
  teamIds: z.array(z.string()).optional(),
});
export type EphemeralKeyUser = z.infer<typeof ephemeralKeyUserSchema>;

/**
 * `POST /v1/ephemeral_keys` — mint a short-lived session credential.
 *
 * Only a secret key (`sk_`) may call this: a session cannot mint itself. By
 * default the key mints into the caller's own organization; naming a different
 * `organizationId` is the multi-tenant case and requires the
 * `ephemeral:mint-any-org` scope, which is the same privilege that allows
 * binding the session's schema to another organization's project.
 */
export const ephemeralKeyRequestSchema = z.object({
  /** The participant this session acts as. `userId` is the older spelling. */
  user: ephemeralKeyUserSchema.optional(),
  userId: z.string().min(1).optional(),
  /**
   * Mint into this organization instead of the caller's own. Requires the
   * `ephemeral:mint-any-org` scope — without it a secret key can never mint a
   * session into another tenant.
   */
  organizationId: z.string().min(1).optional(),
  /**
   * Resolve this session's schema from a shared project rather than from the
   * target organization, while its data stays scoped to that organization.
   * Both fields are set together, and both require `ephemeral:mint-any-org`.
   */
  schemaProjectId: z.string().min(1).optional(),
  schemaOwnerOrgId: z.string().min(1).optional(),
  /** Narrow the session to these sync groups. */
  syncGroups: z.array(z.string()).optional(),
  /** Lifetime in seconds. Capped by the server's maximum. */
  ttlSeconds: z.number().int().positive().optional(),
  /** A human-readable tag recorded with the key, for debugging. */
  label: z.string().optional(),
});
export type EphemeralKeyRequest = z.infer<typeof ephemeralKeyRequestSchema>;

/**
 * The capability mint body lives with the rest of the capability vocabulary in
 * `auth/capability.ts` — the grant is one structure, and its request form is a
 * face of it rather than a separate shape. Re-exported here so the wire barrel
 * stays the single import path for the boundary.
 */
export {
  capabilityRequestSchema,
  grantedOperationSchema,
  capabilityOperationSchema,
} from '../auth/capability.js';
export type {
  CapabilityRequest,
  GrantedOperation,
  CapabilityOperation,
} from '../auth/capability.js';
