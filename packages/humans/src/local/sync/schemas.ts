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
import { AbloValidationError } from "@abloatai/transaction/errors";
import { syncDeltaWireCoreSchema } from '@abloatai/transaction/observation';
import { isPlainObject, isSyncDeltaAction, isWireDeltaData } from './parseWireDelta.js';


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


function fastValidateServerDelta(raw: unknown): raw is ValidatedServerDelta {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const d = raw as Record<string, unknown>;
  return (
    typeof d.id === 'number' &&
    Number.isFinite(d.id) &&
    isSyncDeltaAction(d.actionType) &&
    typeof d.modelName === 'string' &&
    d.modelName.length > 0 &&
    typeof d.modelId === 'string' &&
    d.modelId.length > 0 &&
    isWireDeltaData(d.data)
  );
}

/**
 * Fast-path validator equivalent to `BootstrapResponseSchema.safeParse(raw)`.
 * Returns `null` on any contract mismatch so the caller can fall back to Zod
 * for exact issue diagnostics without slowing down valid multi-thousand-row
 * snapshots or partial-bootstrap delta arrays.
 */
function fastParseBootstrapResponse(raw: unknown): ValidatedBootstrapResponse | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const type = obj.type;
  if (type !== 'full' && type !== 'partial') return null;

  const lastSyncId = obj.lastSyncId;
  if (typeof lastSyncId !== 'number' || !Number.isFinite(lastSyncId)) return null;

  let normalizedModels: Record<string, unknown[]> | undefined;
  if (obj.models !== undefined) {
    if (!isPlainObject(obj.models)) return null;
    let needsCopy = false;
    for (const key in obj.models) {
      if (!Object.prototype.hasOwnProperty.call(obj.models, key)) continue;
      const val = obj.models[key];
      if (Array.isArray(val)) continue;
      if (val === null || typeof val === 'string') {
        needsCopy = true;
        continue;
      }
      return null;
    }
    if (needsCopy) {
      normalizedModels = {};
      for (const key in obj.models) {
        if (!Object.prototype.hasOwnProperty.call(obj.models, key)) continue;
        const val = obj.models[key];
        if (Array.isArray(val)) {
          normalizedModels[key] = val;
        } else if (val === null) {
          normalizedModels[key] = [];
        } else if (typeof val === 'string') {
          try {
            const parsed: unknown = JSON.parse(val);
            normalizedModels[key] = Array.isArray(parsed) ? parsed : [];
          } catch {
            normalizedModels[key] = [];
          }
        }
      }
    } else {
      normalizedModels = obj.models as Record<string, unknown[]>;
    }
  }

  let validatedDeltas: ValidatedServerDelta[] | undefined;
  if (obj.deltas !== undefined) {
    if (!Array.isArray(obj.deltas)) return null;
    for (const delta of obj.deltas) {
      if (!fastValidateServerDelta(delta)) return null;
    }
    validatedDeltas = obj.deltas as ValidatedServerDelta[];
  }

  if (obj.deltaCount !== undefined && (typeof obj.deltaCount !== 'number' || !Number.isFinite(obj.deltaCount))) {
    return null;
  }

  if (obj.failedModels !== undefined) {
    if (!Array.isArray(obj.failedModels)) return null;
    for (const modelName of obj.failedModels) {
      if (typeof modelName !== 'string') return null;
    }
  }

  let timestamp: number;
  if (obj.timestamp === undefined) {
    timestamp = Date.now();
  } else if (typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp)) {
    timestamp = obj.timestamp;
  } else {
    return null;
  }

  if (obj.schemaHash !== undefined && typeof obj.schemaHash !== 'string') return null;
  if (obj.nextCursor !== undefined && typeof obj.nextCursor !== 'string') return null;

  // Preserve unknown keys (.loose()) while applying default timestamp & normalized models.
  if (obj.timestamp !== undefined && (normalizedModels === undefined || normalizedModels === obj.models)) {
    return obj as ValidatedBootstrapResponse;
  }

  const out: Record<string, unknown> = { ...obj, timestamp };
  if (normalizedModels !== undefined) out.models = normalizedModels;
  if (validatedDeltas !== undefined) out.deltas = validatedDeltas;
  return out as ValidatedBootstrapResponse;
}

/**
 * Validates a raw bootstrap response from the server and returns the typed
 * result. On failure it records a diagnostic breadcrumb and throws an
 * {@link AbloValidationError} describing which fields were invalid.
 */
export function parseBootstrapResponse(
  raw: unknown,
  runtime: RuntimeContext = globalRuntime,
): ValidatedBootstrapResponse {
  const fast = fastParseBootstrapResponse(raw);
  if (fast !== null) return fast;

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
