/** Private contract owned by the stateless HTTP transport boundary. */

import type { HttpClientConfig } from './options.js';
import type { CommitReceiptWire } from '../../commit/contract.js';
import type {
  CommitResource,
  HttpClaimsResource,
  HttpLogsResource,
  HttpTransportModel,
} from '../../client/resources/httpResources.js';
import type {
  ClaimAcquired,
  ClaimBeginPayload,
  ClaimGranted,
  ClaimQueued,
} from '../../coordination/schema.js';
import type { CoordinationObservability } from '../../observability.js';
import type { EffectiveAuthority } from '../../auth/capability.js';
import type { SessionAccess } from '../../sessions/index.js';
import type { CommitFrameOperation } from '../websocket/commitFrames.js';
import type { HttpReadOnChange } from './subscription.js';

/** @internal Private options for the schema-agnostic HTTP protocol transport. */
export type HttpTransportOptions = Omit<HttpClientConfig, 'schema'> & {
  readonly bootstrapBaseUrl?: string | undefined;
  /** Observability forwarded from `Ablo({ observability })`. */
  readonly observability?: CoordinationObservability;
  /** Per-request deadline in milliseconds. Pass `0` to disable it. */
  readonly timeoutMs?: number;
  /** @internal Routes writes through the selected duplex transport. */
  readonly dispatchCommit?: ((input: {
    readonly clientTxId: string;
    readonly operations: readonly CommitFrameOperation[];
    readonly reads?: readonly import('../../coordination/schema.js').ReadDependency[] | null;
  }) => Promise<CommitReceiptWire>) | undefined;
  /** @internal Routes held-claim acquisition through the shared socket. */
  readonly dispatchClaim?: ((input: ClaimBeginPayload & {
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly onQueued?: (event: ClaimQueued) => Error | undefined;
  }) => Promise<ClaimAcquired | ClaimGranted>) | undefined;
  /** @internal Releases a socket-acquired claim on that same session. */
  readonly releaseDispatchedClaim?: ((input: {
    readonly claimId: string;
    readonly entityType: string;
    readonly entityId: string;
  }) => Promise<void>) | undefined;
};

/** @internal Private protocol surface wrapped by `AbloHttpClient`. */
export interface HttpTransport {
  ready(): Promise<void>;
  waitForFlush(): Promise<void>;
  /** Drains scheduled commits and active requests. */
  dispose(): Promise<void>;
  purge(): Promise<void>;
  /** @internal Live check used only by `context().onChange`. */
  readonly onChange: HttpReadOnChange;
  readonly commits: CommitResource;
  readonly claims: HttpClaimsResource;
  readonly logs: HttpLogsResource;
  /** Server-confirmed authority of the active bearer, populated by `ready()`. */
  readonly identity: EffectiveAuthority | null;
  model<T = Record<string, unknown>, Fields = T>(
    name: string,
  ): HttpTransportModel<T, Fields>;
  /** Resolve the bearer credential used by this transport. */
  getAuthToken(): Promise<string | null>;
  /** @internal One normalized source shared by HTTP bootstrap and live transport. */
  readonly access: SessionAccess;
}
