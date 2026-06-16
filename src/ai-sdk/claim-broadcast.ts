/**
 * Claim broadcast middleware — wraps a language model so the agent
 * declares "I'm about to edit entity X" over the sync engine's
 * claim primitive at stream start, and abandons the claim at
 * stream end.
 *
 * Cross-cutting by design — composes via the AI SDK's
 * `wrapLanguageModel`. Same middleware works for every chat
 * surface, and for non-chat agent loops that share the AI SDK's
 * middleware interface (workers, MCP tools, autonomous loops).
 *
 * Open-source-clean: depends only on `@ai-sdk/provider` types and
 * the package's own `SyncAgent`. No app-specific assumptions —
 * Ablo's web app uses this, but so can any consumer of `@abloatai/ablo`.
 *
 * Cost: one WS frame at stream start (`claim_begin`), one at end
 * (`claim_abandon`). No DB I/O, no extra LLM tokens.
 */

import type { LanguageModelV3Middleware } from '@ai-sdk/provider';
import type { Ablo } from '../client/Ablo.js';
import type { SchemaRecord } from '../schema/schema.js';
import type { ClaimHandle } from '../types/streams.js';

/**
 * Target entity for the claim broadcast.
 *
 * `entityType` is a free-form string — convention is the schema's
 * typename (e.g. `'SlideDeck'`, `'Task'`, `'Matter'`) so peers can
 * filter consistently. The wire format treats it opaquely.
 */
export interface ClaimTarget {
  readonly entityType: string;
  readonly entityId: string;
  /** Optional path for file/document-like targets. */
  readonly path?: string;
  /** Optional line/column range for partial-entity coordination. */
  readonly range?: {
    readonly startLine: number;
    readonly endLine: number;
    readonly startColumn?: number;
    readonly endColumn?: number;
  };
  /**
   * Optional sub-field within the entity. Useful when the agent
   * knows it's only editing a specific field — peers can filter
   * on the field too.
   */
  readonly field?: string;
  /** App-defined structured metadata. Opaque to the core SDK. */
  readonly meta?: Record<string, unknown>;
  /**
   * Hint for the server-side TTL on the claim. Caps at 10 minutes
   * server-side; default 60s — typical chat turn.
   */
  readonly estimatedMs?: number;
}

export interface ClaimBroadcastMiddlewareOptions<R extends SchemaRecord = SchemaRecord> {
  /** Connected Ablo. Null disables the middleware (no-op). */
  readonly agent: Ablo<R> | null;
  /** Target entity. Null skips the broadcast (purely conversational). */
  readonly target: ClaimTarget | null;
  /**
   * Human-readable phase describing what the agent is doing. Convention:
   * `'edit'`, `'read'`, `'review'`, `'generate'`. Default `'edit'`. The same
   * `reason` field used on every claim surface.
   */
  readonly reason?: string;
  /**
   * Peer-visible explanation of the specific work this model call is about to
   * perform. Surfaces to other agents through `ActiveClaim.description`.
   */
  readonly description?: string;
}

/**
 * Build the middleware. When `agent` or `target` is null, returns a
 * pass-through — keeps call sites unconditional regardless of
 * whether the surface has an entity in scope.
 *
 * Generic over the schema record so callers passing
 * `Ablo<typeof schema>` don't have to widen — `Ablo<S>` and
 * `Ablo<SchemaRecord>` are structurally non-compatible because the
 * widened version collapses model proxies to an index signature
 * that clashes with the named methods (`ready`, `dispose`, etc.).
 */
export function claimBroadcastMiddleware<R extends SchemaRecord = SchemaRecord>(
  options: ClaimBroadcastMiddlewareOptions<R>,
): LanguageModelV3Middleware {
  const { agent, target } = options;
  const reason = options.reason ?? 'edit';
  const description = options.description;

  const openClaim = (): ClaimHandle | null => {
    if (!agent || !target) return null;
    return agent.claims.claim(
      {
        type: target.entityType,
        id: target.entityId,
        path: target.path,
        range: target.range,
        field: target.field,
        meta: target.meta,
      },
      {
        reason,
        description,
        ttl: target.estimatedMs ?? 60_000,
      },
    );
  };

  return {
    specificationVersion: 'v3',
    // The AI SDK's middleware contract passes a no-arg `doStream` /
    // `doGenerate` thunk — params have already been transformed by
    // any earlier `transformParams` middleware in the chain. We
    // open the claim, call the inner, abandon when the inner
    // resolves (or rejects).
    async wrapStream({ doStream }) {
      const handle = openClaim();
      try {
        return await doStream();
      } finally {
        // Always abandon — even on error. The server's TTL would
        // eventually clean up regardless, but explicit release means
        // peers see the claim drop the moment generation completes.
        handle?.revoke();
      }
    },

    async wrapGenerate({ doGenerate }) {
      const handle = openClaim();
      try {
        return await doGenerate();
      } finally {
        handle?.revoke();
      }
    },
  };
}
