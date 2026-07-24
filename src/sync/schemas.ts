/**
 * Zod validation schemas for sync engine server responses.
 *
 * Validates data at the fetch boundary before it enters the sync engine.
 * Unknown keys are kept, so a server that adds a field does not break a client
 * that predates it.
 */

import { z } from 'zod';
import { globalRuntime } from "../context.js";
import type { RuntimeContext } from "../RuntimeContext.js";
import { AbloValidationError } from "../transaction/errors.js";
import { syncDeltaWireCoreSchema } from '../transaction/wire/delta.js';

// ─── Server Delta Schema ─────────────────────────────────────────────────────

/**
 * A delta as it arrives in a bootstrap payload.
 *
 * The bootstrap routes return the same rows the broadcast path does, so the
 * fields are taken from {@link syncDeltaWireCoreSchema} rather than restated
 * here — a delta is one shape, and this is the reader for it, not a second
 * definition of it. Unknown keys are kept, because the server sends its own
 * wider projection (attribution, `projectId`) that later stages may read.
 */
export const ServerDeltaSchema = syncDeltaWireCoreSchema
  .pick({
    id: true,
    actionType: true,
    modelName: true,
    modelId: true,
    data: true,
  })
  .loose();

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
    // Present when a paged single-model request stopped at its row limit
    // with rows remaining: pass it back as the next page's cursor. Absent
    // on the final page, on unpaged responses, and from older servers.
    nextCursor: z.string().optional(),
  })
  .loose();

export type ValidatedBootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

// ─── Parse Helpers ───────────────────────────────────────────────────────────

/**
 * Validates a raw bootstrap response from the server and returns the typed
 * result. On failure it records a diagnostic breadcrumb and throws an
 * {@link AbloValidationError} describing which fields were invalid.
 */
export function parseBootstrapResponse(
  raw: unknown,
  runtime: RuntimeContext = globalRuntime,
): ValidatedBootstrapResponse {
  const result = BootstrapResponseSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

    runtime.observability.breadcrumb(
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
