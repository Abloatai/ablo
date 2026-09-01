import type {
  CapabilityCan,
  CapabilityOperation,
  EffectiveAuthority,
} from '../auth/capability.js';
import type { CredentialEndpointSuccess } from '../auth/credentialEndpointProtocol.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { SyncGroupInput } from '../schema/roles.js';

/** The bearer-bearing part of a session returned by `sessions.create()`. */
export interface SessionCredential {
  readonly object: 'session';
  /** The short-lived `ek_` or `rk_` bearer used by the scoped client. */
  readonly token: string;
  /** ISO-8601 hard expiry for this credential. */
  readonly expiresAt: string;
}

/** Result accepted from a session provider or canonical browser mint endpoint. */
export type SessionProviderResult =
  | SessionCredential
  | CredentialEndpointSuccess
  | null;

/** Re-mints the same logical actor's scoped session for a long-lived client. */
export type SessionProvider = () => Promise<SessionProviderResult>;

/** Browser-safe route that mints the signed-in actor's short-lived session. */
export interface SessionEndpoint {
  readonly endpoint: string;
  readonly timeoutMs?: number;
  readonly allowCrossOrigin?: boolean;
}

/** Every supported source for `Ablo({ session })`. */
export type SessionSource = SessionCredential | SessionProvider | SessionEndpoint;

/** Public session scope; transport-specific sync naming stays below this boundary. */
export type SessionScope = Omit<EffectiveAuthority, 'syncGroups'> & {
  readonly groups: readonly string[];
};

export function sessionScope(authority: EffectiveAuthority): SessionScope {
  const { syncGroups, ...scope } = authority;
  return { ...scope, groups: syncGroups };
}

/** A single data operation a scoped session may perform on a model. */
export type SessionOperation = CapabilityOperation;

/** Parameters for issuing a short-lived end-user (`ek_`) session. */
export interface CreateUserSessionParams<S extends SchemaRecord> {
  readonly user: { readonly id: string };
  readonly organizationId?: string;
  readonly schemaProject?: {
    readonly organizationId: string;
    readonly projectId: string;
  };
  readonly groups?: readonly SyncGroupInput[];
  readonly can: CapabilityCan<S>;
  readonly ttlSeconds?: number;
  readonly userMeta?: Record<string, unknown>;
  readonly agent?: never;
}

/** Parameters for issuing a short-lived scoped agent (`rk_`) session. */
export interface CreateAgentSessionParams<S extends SchemaRecord> {
  readonly agent: { readonly id: string };
  readonly onBehalfOf?: { readonly user: { readonly id: string } };
  readonly can: CapabilityCan<S>;
  readonly groups?: readonly SyncGroupInput[];
  readonly ttlSeconds?: number;
  readonly userMeta?: Record<string, unknown>;
  readonly user?: never;
}

/** The one typed issuance input; its subject selects user or agent identity. */
export type CreateSessionParams<S extends SchemaRecord> =
  | CreateUserSessionParams<S>
  | CreateAgentSessionParams<S>;

/** A minted session. `token` is the secret the holder presents as its bearer. */
export interface AbloSession extends SessionCredential {
  readonly id: string;
  readonly organizationId: string;
  readonly scope: SessionScope;
  readonly userMeta: Record<string, unknown>;
}

export interface SessionRevocation {
  readonly id: string;
  readonly deleted: true;
  readonly activeSessionsClosed: number;
}

export interface SessionRotation {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string | null;
  readonly organizationId: string;
  readonly scope: SessionScope;
  readonly rotatedFrom: {
    readonly id: string;
    readonly expiresAt: string;
  };
}

export interface RevokeSessionParams {
  readonly id: string;
}

export interface RotateSessionParams {
  readonly id: string;
  readonly graceSeconds?: number;
  readonly ttlSeconds?: number;
}
