import type { CommitReceiptWire } from '../../commit/contract.js';
import type { ReadDependency } from '../../coordination/schema.js';
import type {
  ClaimAcquired,
  ClaimBeginPayload,
  ClaimGranted,
  ClaimQueued,
} from '../../coordination/schema.js';
import type { ClientSyncDelta } from '../../observation/contract.js';
import type { ObserveCursorStore } from '../../client/contract.js';
import type { SessionAccess } from '../../sessions/source.js';
import type { CommitFrameOperation } from '../websocket/commitFrames.js';
import type {
  CoreSyncEventMap,
  EventMap,
  PresenceUpdate,
  SyncWebSocketEventMap,
} from '../websocket/transport.js';

export interface WebSocketSessionOptions {
  readonly baseUrl?: string;
  /** Normalized once at the client boundary; transports do not infer policy. */
  readonly access: SessionAccess;
  readonly syncGroups?: readonly string[];
  readonly collaborationEvents?: readonly string[];
  readonly cursorKey?: string;
  readonly cursorStore?: ObserveCursorStore;
  readonly reconnectDelay?: number;
  readonly maxReconnectDelay?: number;
  readonly connectTimeoutMs?: number;
}

export interface WebSocketCommitInput {
  readonly operations: readonly CommitFrameOperation[];
  readonly clientTxId: string;
  readonly reads?: readonly ReadDependency[] | null;
  readonly timeoutMs?: number;
}

export interface WebSocketObservedDelta extends ClientSyncDelta {
  /** Persist and acknowledge this delta as durably applied. */
  checkpoint(): Promise<void>;
}

export interface WebSocketObserveOptions {
  readonly signal?: AbortSignal;
}

/** A durable row/field claim carried over the same live protocol. */
export type WebSocketClaimInput = ClaimBeginPayload & {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onQueued?: (event: ClaimQueued) => Error | undefined;
};
export type WebSocketClaimGrant = ClaimAcquired | ClaimGranted;

export interface WebSocketPresence {
  update(input?: {
    readonly status?: 'online' | 'away' | 'offline';
    readonly customStatus?: string;
    readonly timezone?: string;
    readonly activity?: Record<string, unknown>;
  }): void;
}

export interface WebSocketCollaboration<TEvents extends EventMap<TEvents>> {
  send<K extends string & keyof TEvents>(
    event: K,
    payload: TEvents[K] extends [infer P]
      ? Omit<P & Record<string, unknown>, 'timestamp'>
      : never,
  ): void;
}

export type OpenCollaborationEvents = Record<string, [Record<string, unknown>]>;

export interface AbloWebSocketSession<
  TEvents extends EventMap<TEvents> = OpenCollaborationEvents,
> extends AsyncDisposable {
  readonly presence: WebSocketPresence;
  readonly collaboration: WebSocketCollaboration<TEvents>;
  readonly connected: boolean;
  ready(): Promise<void>;
  commit(input: WebSocketCommitInput): Promise<CommitReceiptWire>;
  claim(input: WebSocketClaimInput): Promise<WebSocketClaimGrant>;
  release(input: {
    readonly claimId: string;
    readonly entityType?: string;
    readonly entityId?: string;
  }): Promise<void>;
  subscribe<K extends keyof SyncWebSocketEventMap<TEvents>>(
    event: K,
    listener: (...args: SyncWebSocketEventMap<TEvents>[K]) => void,
  ): () => void;
  observe(options?: WebSocketObserveOptions): AsyncIterable<WebSocketObservedDelta>;
  updateSubscription(
    syncGroups: readonly string[],
    options?: { timeoutMs?: number },
  ): Promise<{ syncGroups: string[] }>;
  acknowledge(lastSyncId: number): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type WebSocketCoreEvent = keyof CoreSyncEventMap;
export type WebSocketPresenceUpdate = PresenceUpdate;
