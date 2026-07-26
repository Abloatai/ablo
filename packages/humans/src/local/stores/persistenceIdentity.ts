import { AbloConnectionError } from '@abloatai/transaction/errors';

/**
 * The complete authenticated branch that owns one local replica. A branch id
 * is authoritative.
 */
export interface PersistenceIdentity {
  readonly participantId: string;
  readonly participantKind: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly branchId: string;
  readonly branchRoot: boolean;
}

export interface PersistedIdentityMetadata {
  readonly namespaceVersion?: number;
  readonly userId: string;
  readonly workspaceId: string;
  readonly participantKind?: string;
  readonly projectId?: string | null;
  readonly branchId?: string;
  readonly branchRoot?: boolean;
}

export const PERSISTENCE_NAMESPACE_VERSION = 4;

function canonicalIdentity(
  identity: PersistenceIdentity,
  userVersion: number,
): string {
  return JSON.stringify([
    PERSISTENCE_NAMESPACE_VERSION,
    identity.projectId,
    ['branch', identity.branchId, identity.branchRoot],
    identity.organizationId,
    identity.participantKind,
    identity.participantId,
    userVersion,
  ]);
}

async function sha256Hex(value: string): Promise<string> {
  const cryptoProvider = Reflect.get(globalThis, 'crypto') as Crypto | undefined;
  const subtle = cryptoProvider?.subtle;
  if (!subtle) {
    throw new AbloConnectionError(
      'Secure local persistence requires Web Crypto SHA-256 support.',
      { code: 'db_secure_hash_unavailable' },
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Collision-resistant IndexedDB name for one authenticated data plane. */
export async function persistenceDatabaseName(
  identity: PersistenceIdentity,
  userVersion = 1,
): Promise<string> {
  const digest = await sha256Hex(canonicalIdentity(identity, userVersion));
  return `ablo_v${PERSISTENCE_NAMESPACE_VERSION}_${digest}`;
}

/** Defense-in-depth check after namespace lookup and before persisted reads. */
export function persistenceIdentityMatches(
  info: PersistedIdentityMetadata,
  identity: PersistenceIdentity,
): boolean {
  return (
    info.namespaceVersion === PERSISTENCE_NAMESPACE_VERSION &&
    info.userId === identity.participantId &&
    info.workspaceId === identity.organizationId &&
    info.participantKind === identity.participantKind &&
    (info.projectId ?? null) === identity.projectId &&
    info.branchId === identity.branchId &&
    (info.branchRoot ?? false) === identity.branchRoot
  );
}
