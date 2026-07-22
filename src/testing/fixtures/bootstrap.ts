/**
 * Factories that build well-formed bootstrap responses for tests. A
 * bootstrap response is what the server returns when a client first syncs:
 * either a full snapshot of the models or a partial batch of deltas since a
 * known point. These helpers produce the same shapes, so tests can exercise
 * client sync logic without a live server.
 */

import type { BootstrapType } from '../../transaction/types/index.js';

export type BootstrapModelData = Record<string, Record<string, unknown>[]>;

export interface BootstrapResponse {
  type: BootstrapType;
  lastSyncId: number;
  models?: BootstrapModelData;
  deltas?: {
    id: number;
    modelName: string;
    modelId: string;
    action: string;
    data: Record<string, unknown>;
  }[];
  deltaCount?: number;
  failedModels?: string[];
  timestamp: number;
}

/**
 * Builds a full bootstrap response — a fresh snapshot of the given models,
 * as the server sends on a client's first sync.
 */
export function createFullBootstrapResponse(
  models: BootstrapModelData,
  lastSyncId = 100
): BootstrapResponse {
  return {
    type: 'full',
    lastSyncId,
    models,
    timestamp: Date.now(),
  };
}

/**
 * Builds a partial bootstrap response — a batch of deltas applied on top of
 * the client's last known sync point, given by `lastSyncId`.
 */
export function createPartialBootstrapResponse(
  deltas: BootstrapResponse['deltas'],
  lastSyncId: number
): BootstrapResponse {
  return {
    type: 'partial',
    lastSyncId,
    deltas,
    deltaCount: deltas?.length ?? 0,
    timestamp: Date.now(),
  };
}

/**
 * Builds a full bootstrap response with the common test models
 * pre-populated. Pass any of the named model arrays to include them in the
 * snapshot.
 */
export function createTestBootstrapResponse(options: {
  tasks?: Record<string, unknown>[];
  projects?: Record<string, unknown>[];
  slideDecks?: Record<string, unknown>[];
  slides?: Record<string, unknown>[];
  slideLayers?: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
  lastSyncId?: number;
  failedModels?: string[];
} = {}): BootstrapResponse {
  const models: BootstrapModelData = {};

  if (options.tasks) models.Task = options.tasks;
  if (options.projects) models.Project = options.projects;
  if (options.slideDecks) models.SlideDeck = options.slideDecks;
  if (options.slides) models.Slide = options.slides;
  if (options.slideLayers) models.SlideLayer = options.slideLayers;
  if (options.comments) models.Comment = options.comments;

  return {
    type: 'full',
    lastSyncId: options.lastSyncId ?? 100,
    models,
    failedModels: options.failedModels,
    timestamp: Date.now(),
  };
}
