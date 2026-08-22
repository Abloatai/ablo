import type { Model } from './Model.js';
import type { BootstrapData } from './sync/BootstrapFetcher.js';
import type { QueuedMutation } from './transactions/mutations/MutationQueue.js';
import type { CommitTransaction } from './transactions/mutations/commitLane.js';

export interface SyncObserver {
  onSync?: (event: SyncEvent) => void;
}

export interface SyncEvent {
  type: 'create' | 'update' | 'delete' | 'archive' | 'rollback';
  modelType: string;
  model?: Model;
  modelId?: string;
  transactionType?: string;
}

export interface SyncState {
  connectionState: 'connected' | 'disconnected' | 'connecting';
  pendingMutations: number;
  lastSyncAt?: Date;
  error?: Error;
}

export interface RehydrationStats {
  added: number;
  updated: number;
  removed: number;
  skipped: number;
  healed: number;
  elapsedMs: number;
}

export type EventHandler = () => void;

/** The bootstrap fields applied to the local object pool. */
export type BootstrapSnapshot = Pick<BootstrapData, 'models' | 'failedModels'> &
  Partial<Pick<BootstrapData, 'lastSyncId'>>;

/** A completed queued mutation or explicit commit. */
export type CompletedTransaction =
  | (Pick<QueuedMutation, 'id' | 'modelId' | 'syncIdNeededForCompletion'> & {
      lastSyncId?: undefined;
      operations?: undefined;
    })
  | (Pick<CommitTransaction, 'id' | 'lastSyncId' | 'operations'> & {
      modelId?: undefined;
      syncIdNeededForCompletion?: undefined;
    });

/** Normalize an untyped server timestamp for last-write-wins comparison. */
export function toEpochMs(value: unknown): number {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value).getTime();
  }
  return 0;
}
