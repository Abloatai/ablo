/**
 * Types for `@ablo/agent/jobs` — remote AgentJob dispatch primitive.
 *
 * Distinct from `@ablo/agent/agent` (in-process LLM-loop runtime
 * the supervisor exposes as `agent.run()` inside execute-sandbox). The
 * jobs module owns the producer-side primitive: write an AgentJob row,
 * wake the worker fleet, return a handle the caller can wait on or
 * cancel.
 */

// ── Plugins + lifecycle vocab ───────────────────────────────────────────

/**
 * Plugin names the agent-worker fleet dispatches on. Keep the union
 * narrow — adding one without the worker's `sqs-consumer` dispatching
 * it is a silent black-hole.
 *
 * - `workspace` / `deck` / `spreadsheet` — LLM-loop coding-agent jobs.
 * - `subagent` — supervisor-fanned-out peer (rich executeSandbox surface).
 * - `tearsheet` — deterministic pipeline (rag-service /tearsheet/generate).
 * - `review` — review-execute async pipeline.
 */
export const AGENT_PLUGIN_NAMES = [
  'workspace',
  'deck',
  'spreadsheet',
  'subagent',
  'tearsheet',
  'review',
] as const;
export type AgentPluginName = (typeof AGENT_PLUGIN_NAMES)[number];

/** LLM-loop subset — the generic /api/agent/enqueue route only accepts these. */
export const LLM_LOOP_PLUGIN_NAMES = [
  'workspace',
  'deck',
  'spreadsheet',
  'subagent',
] as const;
export type LlmLoopPluginName = (typeof LLM_LOOP_PLUGIN_NAMES)[number];

export const AGENT_MODEL_IDS = ['sonnet', 'openai', 'gemini', 'grok'] as const;
export type AgentModelId = (typeof AGENT_MODEL_IDS)[number];

export const AGENT_JOB_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'cancelling',
  'paused',
] as const;
export type AgentJobStatus = (typeof AGENT_JOB_STATUSES)[number];

export function isTerminalAgentJobStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ── Spec passed to agent.enqueue ────────────────────────────────────────

/**
 * Producer-side spec for `agent.enqueue(...)`. Everything the worker
 * needs to start the job lives on this shape. `input` is opaque to the
 * jobs package — each plugin's worker handler narrows it via its own
 * Zod schema (e.g. `SubagentJobInputSchema`, `TearsheetJobInputSchema`).
 */
export interface AgentJobSpec {
  /** Worker plugin that handles this job. */
  readonly plugin: AgentPluginName;
  /**
   * Model identifier when the plugin is an LLM-loop. Typed as a plain
   * `string` because each plugin owns its own model registry (review
   * accepts the curated shared model catalog (`'sonnet' | 'openai' |
   * 'gemini' | 'grok'`), tearsheet ignores it entirely). The worker narrows on
   * receipt against its plugin-specific union.
   */
  readonly modelId: string;
  /** Owning org — used by the worker to pick the right Ablo connection. */
  readonly organizationId: string;
  /** User who initiated. Becomes the job's principal for auth. */
  readonly userId: string;
  /** Logical chat / conversation grouping. Synthesize one if no chat exists. */
  readonly chatId: string;
  /** Plugin-specific payload. Opaque to the jobs package. */
  readonly input: unknown;
  /**
   * Idempotency key for the row commit. Repeat enqueues with the same
   * key resolve to the same AgentJob row rather than duplicating.
   */
  readonly idempotencyKey: string;
  /** Optional pre-allocated job id. Mint a UUID when omitted. */
  readonly jobId?: string;
  /**
   * Explicit auth for the row-commit transport — captured at the
   * request boundary by the producer and threaded through. Required
   * because the alternative (reaching back into `next/headers` from
   * inside the transport) silently breaks when the dispatch crosses
   * any context-loss boundary (isolated-vm host callbacks, `after()`
   * queue work, worker threads). Making this required forces every
   * dispatch site to capture cookies at the route handler entry,
   * matching the rest of the codebase's auth-threading pattern
   * (`mintSubagentCapability({ auth: { cookieHeader } })`,
   * `persistMutationsInline({ cookieHeader })`).
   */
  readonly auth: {
    readonly cookieHeader: string;
    /**
     * Vercel OIDC JWT captured at the request boundary. Threaded to
     * the dispatch transport's SQS client → STS AssumeRoleWithWebIdentity
     * call, since the underlying `getVercelOidcToken()` reads request
     * context lazily and would throw inside dispatches that cross
     * AsyncLocalStorage (isolated-vm, `after()`, workers). Omit on
     * non-Vercel hosts where AWS creds come from the default chain.
     */
    readonly oidcToken?: string;
  };
}

/** The AgentJob row as observers see it. Mirrors the sync engine model. */
export interface AgentJobRecord {
  readonly id: string;
  readonly organizationId?: string;
  readonly userId: string;
  readonly chatId: string;
  readonly pluginName: string;
  readonly modelId: string;
  readonly status: AgentJobStatus | string;
  readonly input: unknown;
  readonly result?: unknown;
  readonly error?: string | null;
  readonly errorStep?: number | null;
  readonly startedAt?: string | Date | null;
  readonly completedAt?: string | Date | null;
  readonly totalInputTokens?: number | null;
  readonly totalOutputTokens?: number | null;
  readonly createdAt?: string | Date;
  readonly updatedAt?: string | Date;
}

// ── Wait + cancel options ───────────────────────────────────────────────

export interface WaitOptions {
  /**
   * Total wall budget. Past this, throws `AgentJobWaitTimeoutError` and
   * the job keeps running on the worker fleet — observers still see
   * deltas via sync. Default 240s.
   */
  readonly timeoutMs?: number;
  /** Poll interval when no live subscription is available. Default 1s. */
  readonly intervalMs?: number;
  /**
   * How long the row may stay `pending` (never claimed) before
   * `AgentJobDispatchLostError` fires. Producer-side fault signal.
   * Default 30s. Set to `Infinity` to disable.
   */
  readonly dispatchTimeoutMs?: number;
}

// ── Errors ──────────────────────────────────────────────────────────────

/**
 * Wait elapsed before the row reached terminal status — worker is
 * still running it. Observers can keep watching deltas; the supervisor
 * can re-wait or move on.
 */
export class AgentJobWaitTimeoutError extends Error {
  readonly jobId: string;
  readonly timeoutMs: number;
  constructor(jobId: string, timeoutMs: number) {
    super(`Timed out waiting for AgentJob ${jobId} after ${timeoutMs}ms`);
    this.name = 'AgentJobWaitTimeoutError';
    this.jobId = jobId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Row never left `pending` within the dispatch budget — no worker
 * claimed it. Distinct from a wait-timeout so callers surface the
 * producer-side diagnosis: missing dispatch, dead worker fleet, IAM
 * failure.
 */
export class AgentJobDispatchLostError extends Error {
  readonly jobId: string;
  readonly dispatchTimeoutMs: number;
  constructor(jobId: string, dispatchTimeoutMs: number) {
    super(
      `AgentJob ${jobId} was never claimed by a worker within ${dispatchTimeoutMs}ms — likely missing dispatch or no live worker.`,
    );
    this.name = 'AgentJobDispatchLostError';
    this.jobId = jobId;
    this.dispatchTimeoutMs = dispatchTimeoutMs;
  }
}

/**
 * Row was created but the dispatch transport failed. The row has been
 * compensated (flipped to `failed`) so it doesn't linger as `pending`.
 * Caller should surface a 503-class error to the user.
 */
export class AgentJobEnqueueError extends Error {
  readonly jobId: string;
  readonly cause: unknown;
  constructor(jobId: string, cause: unknown) {
    super(
      `Dispatch failed for AgentJob ${jobId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'AgentJobEnqueueError';
    this.jobId = jobId;
    this.cause = cause;
  }
}
