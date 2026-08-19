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
import { capabilityOperationSchema, grantedOperationSchema } from '../auth/capability.js';
import { syncGroupInputSchema } from '../coordination/schema.js';

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
 * `organization:act-as` scope, which is the same privilege that allows
 * binding the session's schema to another organization's project.
 */
export const ephemeralKeyRequestSchema = z.object({
  /** The participant this session acts as. */
  user: ephemeralKeyUserSchema,
  /**
   * Open the session in a DIFFERENT organization, one the caller does not
   * belong to. Requires the `organization:act-as` scope. This is the identity
   * provider case, where each organization is an account in its own right.
   *
   * A platform serving its own customers does not use this: its customers are
   * rows in its own schema, and a session reaches them through `syncGroups`.
   */
  organizationId: z.string().min(1).optional(),
  /**
   * Override the shared project used to resolve this session's schema while
   * its data stays scoped to the target organization. A cross-organization
   * mint defaults both coordinates to the caller key's own project. Both
   * fields are set together, and both require `organization:act-as`.
   */
  schemaProjectId: z.string().min(1).optional(),
  schemaOwnerOrgId: z.string().min(1).optional(),
  /** Narrow the session to these sync groups. */
  syncGroups: z.array(syncGroupInputSchema).readonly().optional(),
  /**
   * Least-privilege allowlist, named model by model. For a caller that knows
   * the schema the session will resolve. Exactly one of this and
   * {@link ephemeralKeyRequestSchema.shape.activeSchemaOperations} is required.
   */
  operations: z.array(grantedOperationSchema).min(1).optional(),
  /**
   * The same allowlist expressed as verbs alone, for a caller that CANNOT know
   * the models: an identity service minting sessions for organizations whose
   * schemas it does not own has no way to name them, and a grant is checked
   * against the session's schema at mint time, so naming another schema's
   * models fails every time.
   *
   * The server expands these across the models in the session's active schema
   * and stores the concrete result, so what lands on the credential is the same
   * enumerated allowlist as the field above. A verb is granted only where the
   * model admits it — an immutable model takes `read` and nothing else.
   */
  activeSchemaOperations: z.array(capabilityOperationSchema).min(1).optional(),
  /**
   * The third grant form: NO data operations at all. For a session that exists
   * only to prove who the user is to a control-plane surface (the dashboard,
   * the CLI's provision-key exchange), which authorizes each call against the
   * member table itself. Such a session must be mintable for an organization
   * that has no active schema — provisioning credentials is how a schema gets
   * pushed in the first place — so this form involves no schema at all. The
   * credential lands with an allowlist that matches nothing, because an EMPTY
   * allowlist reads as unrestricted at the gate rather than as nothing.
   */
  controlPlaneOnly: z.literal(true).optional(),
  /** Lifetime in seconds. Capped by the server's maximum. */
  ttlSeconds: z.number().int().positive().optional(),
  /** A human-readable tag recorded with the key, for debugging. */
  label: z.string().min(1).optional(),
}).refine(
  (request) =>
    (request.schemaProjectId === undefined) ===
    (request.schemaOwnerOrgId === undefined),
  {
    message:
      'schemaProjectId and schemaOwnerOrgId must be provided together',
    path: ['schemaProjectId'],
  },
).refine(
  (request) =>
    [request.operations, request.activeSchemaOperations, request.controlPlaneOnly].filter(
      (form) => form !== undefined,
    ).length === 1,
  {
    // Exactly one, never several and never none. None would leave the
    // credential with an empty allowlist, which reads as UNRESTRICTED at the
    // gate rather than as nothing; several would leave two answers to one
    // question.
    message:
      'provide exactly one of operations, activeSchemaOperations, or controlPlaneOnly',
    path: ['operations'],
  },
);
export type EphemeralKeyRequest = z.infer<typeof ephemeralKeyRequestSchema>;

/**
 * The capability mint body lives with the rest of the capability vocabulary in
 * `auth/capability.ts` — the grant is one structure, and its request form is a
 * face of it rather than a separate shape. Re-exported here so the wire barrel
 * stays the single import path for the boundary.
 *
 * This is the only import wire makes for something larger than a schema leaf,
 * so it carries exactly the shape the barrel forwards and nothing else: the
 * grant's own vocabulary — the verb enum, the `model.verb` spelling, the
 * helpers that derive one from the other — is read from `auth/capability.ts`
 * by the callers that build a grant, not through here.
 */
export {
  capabilityRequestSchema,
  capabilityMintResponseSchema,
} from '../auth/capability.js';
export type { CapabilityMintResponse } from '../auth/capability.js';
export type { CapabilityRequest } from '../auth/capability.js';
