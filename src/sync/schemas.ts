/**
 * Zod validation schemas for sync engine server responses.
 *
 * Validates data at the fetch boundary before it enters the sync engine.
 * Uses .passthrough() so the server can add fields without breaking clients.
 */

import { z } from 'zod';
import { getContext } from "../context.js";
import { AbloValidationError } from "../errors.js";

// ─── Sync Action Types ───────────────────────────────────────────────────────
// Mirror of SyncActionType from sync-engine/types.ts

const SYNC_ACTION_VALUES = ['I', 'U', 'D', 'A', 'C', 'G', 'S', 'V'] as const;

// ─── Server Delta Schema ─────────────────────────────────────────────────────

export const ServerDeltaSchema = z
  .object({
    id: z.number(),
    operation: z.enum(SYNC_ACTION_VALUES).optional(),
    action: z.enum(SYNC_ACTION_VALUES).optional(),
    modelName: z.string(),
    entityId: z.string().optional(),
    modelId: z.string().optional(),
    data: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export type ValidatedServerDelta = z.infer<typeof ServerDeltaSchema>;

// ─── Model Value Schema ─────────────────────────────────────────────────────
// Server model values arrive in multiple shapes depending on Go serialization:
//   - Array: already-parsed JSON array (most common)
//   - String: double-encoded JSON string from json.RawMessage
//   - null: from PostgreSQL jsonb_agg with no matching rows
// This schema normalizes all variants into unknown[] before downstream use.

const ModelValueSchema = z
  .union([z.array(z.unknown()), z.string(), z.null()])
  .transform((val): unknown[] => {
    if (val === null) return [];
    if (typeof val === 'string') {
      try {
        const parsed: unknown = JSON.parse(val);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return val;
  });

// ─── Bootstrap Response Schema ───────────────────────────────────────────────

export const BootstrapResponseSchema = z
  .object({
    type: z.enum(['full', 'partial']),
    lastSyncId: z.number(),
    models: z.record(z.string(), ModelValueSchema).optional(),
    deltas: z.array(ServerDeltaSchema).optional(),
    deltaCount: z.number().optional(),
    failedModels: z.array(z.string()).optional(),
    timestamp: z.number().default(() => Date.now()),
  })
  .passthrough();

export type ValidatedBootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

// ─── Parse Helpers ───────────────────────────────────────────────────────────

/**
 * Validate a raw bootstrap response from the server.
 * Logs validation failures via SyncObservability and throws a descriptive error.
 */
export function parseBootstrapResponse(raw: unknown): ValidatedBootstrapResponse {
  const result = BootstrapResponseSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

    getContext().observability.breadcrumb(
      'Bootstrap response validation failed',
      'sync.bootstrap',
      'error',
      {
        issues,
        rawType: typeof raw,
        rawKeys: raw && typeof raw === 'object' ? Object.keys(raw).join(',') : 'n/a',
      }
    );

    throw new AbloValidationError(`Invalid bootstrap response: ${issues}`, {
      code: 'bootstrap_response_schema_invalid',
    });
  }

  return result.data;
}
