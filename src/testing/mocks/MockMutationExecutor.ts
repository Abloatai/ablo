/**
 * A test double for {@link MutationExecutor} that records every call instead
 * of writing to a database. Use it to assert what a component tried to commit
 * and to script the response — success, failure, or added latency — without a
 * live backend. Each successful commit hands back an incrementing `lastSyncId`,
 * so tests can drive the delta-confirmation flow that depends on those ids.
 */

import type {
  MutationExecutor,
  MutationOperation,
  MutationOptions,
  CommitResult,
} from '../../interfaces/index.js';
import type { StaleNotification } from '../../coordination/schema.js';
import { AbloError } from '../../errors.js';

export interface CapturedMutation {
  method: string;
  modelName?: string;
  modelId?: string;
  input?: Record<string, unknown>;
  operations?: MutationOperation[];
  options?: MutationOptions;
  clientMutationId?: string;
  timestamp: number;
}

export interface MockMutationExecutorOptions {
  /** The first `lastSyncId` to return. It increments by one after each commit. */
  initialSyncId?: number;
  /** Whether mutations succeed by default. Set this false to make every call reject. */
  shouldSucceed?: boolean;
  /** A delay applied before each call resolves, in milliseconds, to simulate a slow network. */
  latencyMs?: number;
  /** Optional explicit receipt status. Omission preserves legacy confirmed semantics. */
  status?: CommitResult['status'];
  /** Optional server-issued source/WAL correlation returned with queued receipts. */
  correlationId?: string;
  /** Optional stale-context notifications returned with each commit. */
  notifications?: StaleNotification[];
  /** Optional zero-row target ids returned with each commit. */
  missingIds?: string[];
}

export class MockMutationExecutor implements MutationExecutor {
  /** Every captured call, in the order it was made. Assertions read from this list. */
  readonly calls: CapturedMutation[] = [];

  /** Current sync ID — incremented on each successful commit */
  private _syncId: number;
  private _shouldSucceed: boolean;
  private _latencyMs: number;
  private _status: CommitResult['status'];
  private _correlationId: string | undefined;
  private _notifications: StaleNotification[] | undefined;
  private _missingIds: string[] | undefined;

  /** Per-method failure overrides: method name → error */
  private _failureOverrides = new Map<string, Error>();

  /** Per-method response overrides */
  private _responseOverrides = new Map<string, unknown>();

  constructor(options: MockMutationExecutorOptions = {}) {
    this._syncId = options.initialSyncId ?? 1;
    this._shouldSucceed = options.shouldSucceed ?? true;
    this._latencyMs = options.latencyMs ?? 0;
    this._status = options.status;
    this._correlationId = options.correlationId;
    this._notifications = options.notifications;
    this._missingIds = options.missingIds;
  }

  // ─────────────────────────────────────────────
  // Test control API
  // ─────────────────────────────────────────────

  /** Returns the current sync id without advancing it. */
  get currentSyncId(): number {
    return this._syncId;
  }

  /** Sets the next sync id the executor will return. */
  setSyncId(id: number): void {
    this._syncId = id;
  }

  /** Sets the settlement status returned by subsequent commit calls. */
  setStatus(status: CommitResult['status']): void {
    this._status = status;
  }

  /** Sets the opaque source/WAL correlation returned by subsequent commits. */
  setCorrelationId(correlationId: string | undefined): void {
    this._correlationId = correlationId;
  }

  /** Sets stale-context notifications returned by subsequent commit calls. */
  setNotifications(notifications: StaleNotification[] | undefined): void {
    this._notifications = notifications;
  }

  /** Sets zero-row target ids returned by subsequent commit calls. */
  setMissingIds(missingIds: string[] | undefined): void {
    this._missingIds = missingIds;
  }

  /** Makes every mutation reject. Pass an error to control what is thrown. */
  failAll(error?: Error): void {
    this._shouldSucceed = false;
    if (error) {
      this._failureOverrides.set('*', error);
    }
  }

  /** Restores the default where mutations succeed, clearing any failure overrides. */
  succeedAll(): void {
    this._shouldSucceed = true;
    this._failureOverrides.clear();
  }

  /** Makes a single named method reject. Pass an error to control what is thrown. */
  failMethod(method: string, error?: Error): void {
    this._failureOverrides.set(method, error ?? new Error(`Mock ${method} failed`));
  }

  /** Removes the failure override for one method. */
  clearFailure(method: string): void {
    this._failureOverrides.delete(method);
  }

  /** Returns the captured calls for one method, in order. */
  getCallsByMethod(method: string): CapturedMutation[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** The most recent captured call, or undefined if none have been made. */
  get lastCall(): CapturedMutation | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** Clears captured calls and restores the initial options. */
  reset(options?: MockMutationExecutorOptions): void {
    this.calls.length = 0;
    this._syncId = options?.initialSyncId ?? 1;
    this._shouldSucceed = options?.shouldSucceed ?? true;
    this._latencyMs = options?.latencyMs ?? 0;
    this._status = options?.status;
    this._correlationId = options?.correlationId;
    this._notifications = options?.notifications;
    this._missingIds = options?.missingIds;
    this._failureOverrides.clear();
    this._responseOverrides.clear();
  }

  // ─────────────────────────────────────────────
  // MutationExecutor interface implementation
  // ─────────────────────────────────────────────

  async commit(
    operations: MutationOperation[],
    options?: MutationOptions,
  ): Promise<CommitResult> {
    this._capture('commit', { operations, options });

    await this._maybeDelay();
    this._maybeThrow('commit');

    const syncId = this._syncId++;
    if (this._status === 'queued') {
      if (!this._correlationId) {
        throw new Error('Mock queued commits require a correlationId');
      }
      return {
        lastSyncId: 0,
        status: 'queued',
        correlationId: this._correlationId,
        ...(this._notifications ? { notifications: this._notifications } : {}),
        ...(this._missingIds ? { missingIds: this._missingIds } : {}),
      };
    }
    const evidence = {
      ...(this._notifications ? { notifications: this._notifications } : {}),
      ...(this._missingIds ? { missingIds: this._missingIds } : {}),
    };
    if (this._status === 'confirmed') {
      return {
        lastSyncId: syncId,
        status: 'confirmed',
        ...(this._correlationId ? { correlationId: this._correlationId } : {}),
        ...evidence,
      };
    }
    return { lastSyncId: syncId, ...evidence };
  }

  async executeCreate(
    modelName: string,
    id: string,
    input: Record<string, unknown>,
    clientMutationId?: string
  ): Promise<void> {
    this._capture('executeCreate', { modelName, modelId: id, input, clientMutationId });

    await this._maybeDelay();
    this._maybeThrow('executeCreate');
  }

  async executeUpdate(
    modelName: string,
    modelId: string,
    data: Record<string, unknown>,
    clientMutationId?: string
  ): Promise<CommitResult | null> {
    this._capture('executeUpdate', { modelName, modelId, input: data, clientMutationId });

    await this._maybeDelay();
    this._maybeThrow('executeUpdate');

    return { lastSyncId: this._syncId++ };
  }

  async executeDelete(
    modelName: string,
    modelId: string,
    clientMutationId?: string
  ): Promise<void> {
    this._capture('executeDelete', { modelName, modelId, clientMutationId });

    await this._maybeDelay();
    this._maybeThrow('executeDelete');
  }

  async executeArchive(
    modelName: string,
    modelId: string,
    clientMutationId?: string
  ): Promise<void> {
    this._capture('executeArchive', { modelName, modelId, clientMutationId });

    await this._maybeDelay();
    this._maybeThrow('executeArchive');
  }

  async executeUnarchive(
    modelName: string,
    modelId: string,
    clientMutationId?: string
  ): Promise<void> {
    this._capture('executeUnarchive', { modelName, modelId, clientMutationId });

    await this._maybeDelay();
    this._maybeThrow('executeUnarchive');
  }

  // ─────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────

  private _capture(
    method: string,
    data: Partial<CapturedMutation>
  ): void {
    this.calls.push({
      method,
      timestamp: Date.now(),
      ...data,
    });
  }

  private async _maybeDelay(): Promise<void> {
    if (this._latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this._latencyMs));
    }
  }

  private _maybeThrow(method: string): void {
    // Check specific method override first
    const methodError = this._failureOverrides.get(method);
    if (methodError) throw methodError;

    // Check global override
    const globalError = this._failureOverrides.get('*');
    if (globalError) throw globalError;

    // Check global flag
    if (!this._shouldSucceed) {
      throw new AbloError(`Mock mutation failed: ${method}`, {
        code: 'mock_mutation_failed',
      });
    }
  }
}
