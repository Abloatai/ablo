/**
 * MockMutationExecutor — Test double for the MutationExecutor interface.
 *
 * Captures all mutation calls, allows controlled responses (success/failure/latency),
 * and returns configurable lastSyncId for delta confirmation testing.
 */

import type {
  MutationExecutor,
  MutationOperation,
  BatchAckResult,
} from '../../interfaces';
import { AbloError } from '../../errors';

export interface CapturedMutation {
  method: string;
  modelName?: string;
  modelId?: string;
  input?: Record<string, unknown>;
  operations?: MutationOperation[];
  clientMutationId?: string;
  timestamp: number;
}

export interface MockMutationExecutorOptions {
  /** Starting lastSyncId — increments by 1 per batchAck call */
  initialSyncId?: number;
  /** Whether mutations should succeed by default */
  shouldSucceed?: boolean;
  /** Simulated network latency in ms */
  latencyMs?: number;
}

export class MockMutationExecutor implements MutationExecutor {
  /** All captured mutation calls in order */
  readonly calls: CapturedMutation[] = [];

  /** Current sync ID — incremented on each successful batchAck */
  private _syncId: number;
  private _shouldSucceed: boolean;
  private _latencyMs: number;

  /** Per-method failure overrides: method name → error */
  private _failureOverrides = new Map<string, Error>();

  /** Per-method response overrides */
  private _responseOverrides = new Map<string, unknown>();

  constructor(options: MockMutationExecutorOptions = {}) {
    this._syncId = options.initialSyncId ?? 1;
    this._shouldSucceed = options.shouldSucceed ?? true;
    this._latencyMs = options.latencyMs ?? 0;
  }

  // ─────────────────────────────────────────────
  // Test control API
  // ─────────────────────────────────────────────

  /** Get current sync ID without incrementing */
  get currentSyncId(): number {
    return this._syncId;
  }

  /** Set the next sync ID to return */
  setSyncId(id: number): void {
    this._syncId = id;
  }

  /** Make all mutations fail with given error */
  failAll(error?: Error): void {
    this._shouldSucceed = false;
    if (error) {
      this._failureOverrides.set('*', error);
    }
  }

  /** Make all mutations succeed again */
  succeedAll(): void {
    this._shouldSucceed = true;
    this._failureOverrides.clear();
  }

  /** Make a specific method fail */
  failMethod(method: string, error?: Error): void {
    this._failureOverrides.set(method, error ?? new Error(`Mock ${method} failed`));
  }

  /** Clear failure override for a method */
  clearFailure(method: string): void {
    this._failureOverrides.delete(method);
  }

  /** Get calls filtered by method */
  getCallsByMethod(method: string): CapturedMutation[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Get the last call made */
  get lastCall(): CapturedMutation | undefined {
    return this.calls[this.calls.length - 1];
  }

  /** Reset all state */
  reset(options?: MockMutationExecutorOptions): void {
    this.calls.length = 0;
    this._syncId = options?.initialSyncId ?? 1;
    this._shouldSucceed = options?.shouldSucceed ?? true;
    this._latencyMs = options?.latencyMs ?? 0;
    this._failureOverrides.clear();
    this._responseOverrides.clear();
  }

  // ─────────────────────────────────────────────
  // MutationExecutor interface implementation
  // ─────────────────────────────────────────────

  async commit(operations: MutationOperation[]): Promise<BatchAckResult> {
    this._capture('commit', { operations });

    await this._maybeDelay();
    this._maybeThrow('commit');

    const syncId = this._syncId++;
    return { lastSyncId: syncId };
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
  ): Promise<BatchAckResult | null> {
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
