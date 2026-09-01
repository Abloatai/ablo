import {
  AbloClaimedError,
  AbloConnectionError,
  AbloSessionError,
  errorFromWire,
  isAccessCredentialExpiryCloseReason,
} from '../../errors.js';
import { classifyCredentialKind } from '../../auth/credentialKind.js';
import {
  credentialToken,
  type CredentialProviderResult,
} from '../../auth/credentialResult.js';
import { CredentialLifecycle } from '../../sessions/lifecycle.js';
import {
  clientSyncDeltaSchema,
  type ClientSyncDelta,
} from '../../observation/contract.js';
import {
  WsTransport,
  type EventMap,
  type SyncWebSocketEventMap,
} from './transport.js';
import type {
  AbloWebSocketSession,
  WebSocketClaimInput,
  WebSocketCollaboration,
  WebSocketCommitInput,
  WebSocketObserveOptions,
  WebSocketObservedDelta,
  WebSocketPresence,
  WebSocketSessionOptions,
  OpenCollaborationEvents,
} from './sessionContract.js';

interface StoredPosition {
  readonly lastSyncId: number;
  readonly cursor: string | null;
}

const MAX_BUFFERED_OBSERVATION_DELTAS = 1_024;

function parsePosition(value: string | null): StoredPosition {
  if (!value) return { lastSyncId: 0, cursor: null };
  try {
    const parsed = JSON.parse(value) as { lastSyncId?: unknown; cursor?: unknown };
    if (
      Number.isSafeInteger(parsed.lastSyncId)
      && (parsed.lastSyncId as number) >= 0
      && (parsed.cursor === null || typeof parsed.cursor === 'string')
    ) {
      return {
        lastSyncId: parsed.lastSyncId as number,
        cursor: parsed.cursor as string | null,
      };
    }
  } catch {
    // Pre-live stores may contain the HTTP feed cursor. It is a different
    // protocol position, so failing closed at zero is safer than skipping.
  }
  return { lastSyncId: 0, cursor: null };
}

class AgentWebSocket<
  TEvents extends EventMap<TEvents>,
> extends WsTransport<TEvents> {
  private position: StoredPosition;

  constructor(
    options: ConstructorParameters<typeof WsTransport<TEvents>>[0],
    position: StoredPosition,
  ) {
    super(options);
    this.position = position;
  }

  protected override resumeCursor(): string {
    return this.position.cursor ?? '';
  }

  protected override onOpened(): void {
    this.updatePresence();
    this.requestSync(this.position);
  }

  protected override handleDelta(raw: unknown): void {
    const parsed = clientSyncDeltaSchema.safeParse(raw);
    if (parsed.success) this.emit('delta', parsed.data);
  }

  protected override handleSyncResponse(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const response = raw as {
      deltas?: unknown;
      newCursor?: unknown;
      cursor?: unknown;
      currentSyncId?: unknown;
    };
    if (Array.isArray(response.deltas)) {
      for (const delta of response.deltas) this.handleDelta(delta);
    }
    this.emit('sync_response', response);
  }

  positionAfter(lastSyncId: number): StoredPosition {
    return {
      lastSyncId: Math.max(this.position.lastSyncId, lastSyncId),
      cursor: this.position.cursor,
    };
  }

  markDurable(position: StoredPosition): void {
    this.position = position;
  }

  durablePosition(): StoredPosition {
    return this.position;
  }

  requestFromDurablePosition(): void {
    this.requestSync(this.position);
  }
}

class WebSocketSession<TEvents extends EventMap<TEvents>>
  implements AbloWebSocketSession<TEvents> {
  private readonly socket: AgentWebSocket<TEvents>;
  private readonly options: WebSocketSessionOptions;
  private readonly cursorKey: string;
  private readyPromise: Promise<void> | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private closed = false;
  private currentToken: string;
  private acknowledgeLane: Promise<void> = Promise.resolve();
  private terminalError: Error | null = null;
  private readonly terminalListeners = new Set<(error: Error) => void>();
  private readonly credentialLifecycle: CredentialLifecycle | null;
  private pendingSessionError: Error | null = null;

  readonly presence: WebSocketPresence;
  readonly collaboration: WebSocketCollaboration<TEvents>;

  constructor(
    options: WebSocketSessionOptions,
    position: StoredPosition,
    credential: CredentialProviderResult,
  ) {
    this.options = options;
    const token = credentialToken(credential);
    if (!token) {
      throw new AbloSessionError('The WebSocket transport requires an authenticated credential.');
    }
    this.currentToken = token;
    this.cursorKey = options.cursorKey ?? 'websocket';
    this.socket = new AgentWebSocket<TEvents>({
      baseUrl: options.baseUrl,
      kind: classifyCredentialKind(token) === 'ephemeral' ? 'user' : 'agent',
      getAuthToken: () => this.currentToken,
      syncGroups: [...(options.syncGroups ?? [])],
      collaborationEvents: [...(options.collaborationEvents ?? [])],
      reconnectDelay: options.reconnectDelay,
      maxReconnectDelay: options.maxReconnectDelay,
    }, position);
    this.presence = {
      update: (input = {}) => this.socket.updatePresence(input),
    };
    this.collaboration = {
      send: (event, payload) => this.socket.sendCollaborationEvent(event, payload),
    } as WebSocketCollaboration<TEvents>;
    this.socket.subscribe('session_error', (error) => {
      this.handleSessionError(error);
    });
    this.credentialLifecycle = options.access.renewable
      ? new CredentialLifecycle({
        setAuthToken: (freshToken) => {
          this.currentToken = freshToken;
        },
        nudgeReconnect: () => {
          if (this.closed || this.terminalError) return;
          this.socket.clearSessionError();
          this.socket.resetReconnectAttempts();
          this.socket.connect();
        },
        reportSessionExpired: () => {
          this.failTerminal(this.pendingSessionError ?? new AbloSessionError(
            'The application session ended while renewing its Ablo session.',
          ));
        },
      })
      : null;
    if (this.credentialLifecycle) {
      this.credentialLifecycle.start(() => this.loadCredential(), { proactiveInNode: true });
      this.credentialLifecycle.accept(credential);
    }
  }

  private async loadCredential(): Promise<CredentialProviderResult> {
    return this.options.access.credential();
  }

  private handleSessionError(error: Error): void {
    if (
      !this.credentialLifecycle
      || !isAccessCredentialExpiryCloseReason(error.message)
    ) {
      this.failTerminal(error);
      return;
    }
    this.pendingSessionError = error;
    void this.credentialLifecycle.recoverFromAuthRejection('access_credential_expiry');
  }

  private failTerminal(error: Error): void {
    if (this.terminalError || this.closed) return;
    this.terminalError = error;
    this.socket.setSessionErrorDetected();
    this.socket.disconnect();
    for (const listener of this.terminalListeners) listener(error);
  }

  private onTerminal(listener: (error: Error) => void): () => void {
    if (this.terminalError) {
      const error = this.terminalError;
      queueMicrotask(() => listener(error));
      return () => undefined;
    }
    this.terminalListeners.add(listener);
    return () => this.terminalListeners.delete(listener);
  }

  get connected(): boolean {
    return this.socket.isConnected();
  }

  ready(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new AbloConnectionError('The WebSocket session is closed.'));
    }
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.socket.isConnected()) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const rejectConnection = (error: Error): void => {
        cleanup();
        reject(error);
      };
      this.rejectReady = rejectConnection;
      const timeout = setTimeout(() => {
        rejectConnection(new AbloConnectionError('The WebSocket connection timed out.'));
      }, this.options.connectTimeoutMs ?? 15_000);
      const connected = this.socket.subscribe('connected', () => {
        cleanup();
        resolve();
      });
      const failed = this.onTerminal((error) => {
        rejectConnection(error);
      });
      const mismatch = this.socket.subscribe('protocol_mismatch', () => {
        rejectConnection(new AbloConnectionError('The server rejected this live protocol version.', {
          code: 'protocol_version_unsupported',
        }));
      });
      const cleanup = (): void => {
        clearTimeout(timeout);
        connected();
        failed();
        mismatch();
        this.readyPromise = null;
        this.rejectReady = null;
      };
      this.socket.connect();
    });
    return this.readyPromise;
  }

  async commit(input: WebSocketCommitInput) {
    await this.ready();
    return this.socket.sendCommitReceipt(
      input.operations,
      input.clientTxId,
      input.timeoutMs,
      input.reads,
    );
  }

  async claim(input: WebSocketClaimInput) {
    await this.ready();
    const timeoutMs = input.timeoutMs ?? 15_000;
    return new Promise<import('../../coordination/schema.js').ClaimAcquired | import('../../coordination/schema.js').ClaimGranted>((resolve, reject) => {
      const cleanups: (() => void)[] = [];
      const finish = (outcome: () => void): void => {
        clearTimeout(timeout);
        for (const cleanup of cleanups) cleanup();
        outcome();
      };
      const matches = (event: { claimId: string }): boolean => event.claimId === input.claimId;
      cleanups.push(this.socket.subscribe('claim_acquired', (event) => {
        if (matches(event)) finish(() => resolve(event));
      }));
      cleanups.push(this.socket.subscribe('claim_granted', (event) => {
        if (matches(event)) finish(() => resolve(event));
      }));
      cleanups.push(this.socket.subscribe('claim_queued', (event) => {
        if (!matches(event)) return;
        const refusal = input.onQueued?.(event);
        if (refusal) {
          this.release({
            claimId: input.claimId,
            entityType: input.entityType,
            entityId: input.entityId,
          });
          finish(() => reject(refusal));
        }
      }));
      cleanups.push(this.socket.subscribe('claim_rejected', (event) => {
        if (!matches(event)) return;
        finish(() => reject(errorFromWire(
          event.message ?? `Claim ${event.claimId} was rejected.`,
          {
            code: event.reason === 'conflict' ? 'claim_conflict' : 'claim_rejected',
            details: {
              ...(event.target ? { target: event.target } : {}),
              ...(event.heldBy ? { heldBy: event.heldBy } : {}),
              ...(event.heldByClaimId ? { heldByClaimId: event.heldByClaimId } : {}),
            },
          },
        )));
      }));
      cleanups.push(this.socket.subscribe('disconnected', () => {
        finish(() => reject(new AbloConnectionError(
          `WebSocket closed while claim ${input.claimId} was pending.`,
        )));
      }));
      const abort = (): void => {
        this.release({
          claimId: input.claimId,
          entityType: input.entityType,
          entityId: input.entityId,
        });
        finish(() => reject(new AbloClaimedError(
          `The wait for claim ${input.claimId} was aborted.`,
          { code: 'claim_wait_aborted' },
        )));
      };
      input.signal?.addEventListener('abort', abort, { once: true });
      cleanups.push(() => input.signal?.removeEventListener('abort', abort));
      const timeout = setTimeout(() => {
        this.release({
          claimId: input.claimId,
          entityType: input.entityType,
          entityId: input.entityId,
        });
        finish(() => reject(new AbloClaimedError(
          `claim timed out after ${timeoutMs}ms (claimId=${input.claimId})`,
          { code: 'grant_timeout' },
        )));
      }, timeoutMs);
      if (input.signal?.aborted) {
        abort();
        return;
      }
      const {
        timeoutMs: _timeoutMs,
        signal: _signal,
        onQueued: _onQueued,
        ...payload
      } = input;
      this.socket.send({ type: 'claim_begin', payload });
    });
  }

  release(input: { claimId: string; entityType?: string; entityId?: string }): void {
    this.socket.send({ type: 'claim_abandon', payload: input });
  }

  subscribe<K extends keyof SyncWebSocketEventMap<TEvents>>(
    event: K,
    listener: (...args: SyncWebSocketEventMap<TEvents>[K]) => void,
  ): () => void {
    return this.socket.subscribe(event, listener);
  }

  async *observe(options: WebSocketObserveOptions = {}): AsyncIterable<WebSocketObservedDelta> {
    await this.ready();
    const queued: ClientSyncDelta[] = [];
    const queuedIds = new Set<number>();
    let wake: (() => void) | undefined;
    let failure: unknown;
    const offDelta = this.socket.subscribe('delta', (delta) => {
      if (
        failure
        || delta.id <= this.socket.durablePosition().lastSyncId
        || queuedIds.has(delta.id)
      ) return;
      if (queued.length >= MAX_BUFFERED_OBSERVATION_DELTAS) {
        failure = new AbloConnectionError(
          `WebSocket observation exceeded ${MAX_BUFFERED_OBSERVATION_DELTAS} uncheckpointed deltas; restart observation to resume from the durable cursor.`,
          { code: 'observation_buffer_overflow' },
        );
        wake?.();
        wake = undefined;
        return;
      }
      queued.push(delta);
      queuedIds.add(delta.id);
      wake?.();
      wake = undefined;
    });
    const offError = this.onTerminal((error) => {
      failure = error;
      wake?.();
      wake = undefined;
    });
    const abort = (): void => {
      wake?.();
      wake = undefined;
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    // Retain nothing while idle. Register first, then replay from the durable
    // position so starting observation cannot miss a delta from the gap.
    this.socket.requestFromDurablePosition();
    try {
      while (!this.closed && !options.signal?.aborted) {
        if (failure) throw failure;
        const delta = queued.shift();
        if (!delta) {
          await new Promise<void>((resolve) => { wake = resolve; });
          continue;
        }
        queuedIds.delete(delta.id);
        if (delta.id <= this.socket.durablePosition().lastSyncId) continue;
        let checkpointed = false;
        let checkpointing: Promise<void> | undefined;
        yield {
          ...delta,
          checkpoint: async () => {
            if (checkpointed) return;
            checkpointing ??= this.acknowledge(delta.id).then(() => {
              checkpointed = true;
            }).finally(() => {
              checkpointing = undefined;
            });
            await checkpointing;
          },
        };
      }
    } finally {
      offDelta();
      offError();
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async updateSubscription(syncGroups: readonly string[], options?: { timeoutMs?: number }) {
    await this.ready();
    return this.socket.updateSubscription(syncGroups, options);
  }

  async acknowledge(lastSyncId: number): Promise<void> {
    const attempt = this.acknowledgeLane.catch(() => undefined).then(async () => {
      const position = this.socket.positionAfter(lastSyncId);
      await this.options.cursorStore?.save(this.cursorKey, JSON.stringify(position));
      this.socket.markDurable(position);
      this.socket.acknowledge(position.lastSyncId);
    });
    this.acknowledgeLane = attempt.catch(() => undefined);
    await attempt;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.credentialLifecycle?.stop();
    this.terminalListeners.clear();
    this.rejectReady?.(new AbloConnectionError('The WebSocket session was disposed.'));
    await this.acknowledgeLane;
    this.socket.disconnect();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

export async function createWebSocketSession<
  TEvents extends EventMap<TEvents> = OpenCollaborationEvents,
>(
  options: WebSocketSessionOptions,
  signal?: AbortSignal,
): Promise<AbloWebSocketSession<TEvents>> {
  const cursorKey = options.cursorKey ?? 'websocket';
  const stored = await options.cursorStore?.load(cursorKey) ?? null;
  const credential = await options.access.credential();
  const token = credentialToken(credential);
  if (!token) {
    throw new AbloSessionError('The WebSocket transport requires an authenticated credential.');
  }
  const session = new WebSocketSession<TEvents>(
    options,
    parsePosition(stored),
    credential,
  );
  let rejectOpening: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOpening = reject;
    if (signal?.aborted) {
      reject(new AbloConnectionError('WebSocket opening was disposed.'));
    }
  });
  const abort = (): void => {
    rejectOpening?.(new AbloConnectionError('WebSocket opening was disposed.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await (signal ? Promise.race([session.ready(), aborted]) : session.ready());
    return session;
  } catch (error) {
    await session.close();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}
