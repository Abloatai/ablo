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
// The action codes a server delta can carry, matching the wire protocol's
// action-type set.

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
// A model's values can arrive in more than one shape depending on how the
// server serialized them:
//   - Array: an already-parsed JSON array (the common case)
//   - String: a JSON array still encoded as a string, which must be parsed
//   - null: no matching rows
// This schema normalizes every variant into an array before downstream use.

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
    // The server's active schema hash, used to detect schema drift. Optional:
    // absent when the server predates this field or the tenant has never
    // pushed a schema.
    schemaHash: z.string().optional(),
  })
  .passthrough();

export type ValidatedBootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

// ─── Parse Helpers ───────────────────────────────────────────────────────────

/**
 * Validates a raw bootstrap response from the server and returns the typed
 * result. On failure it records a diagnostic breadcrumb and throws an
 * {@link AbloValidationError} describing which fields were invalid.
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
