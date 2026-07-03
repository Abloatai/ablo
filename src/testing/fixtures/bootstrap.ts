/**
 * Bootstrap response factories for sync engine tests.
 *
 * Creates well-formed bootstrap responses matching the server API.
 */

import type { BootstrapType } from '../../types/index.js';

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
 * Create a full bootstrap response (fresh snapshot from server).
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
 * Create a partial bootstrap response (delta batch from lastSyncId).
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
 * Create a full bootstrap response with test model data pre-populated.
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
