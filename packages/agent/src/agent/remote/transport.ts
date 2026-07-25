/**
 * Transport contracts for `agent.run(spec)`.
 *
 * The jobs runtime owns the create-row + enqueue PAIR but knows
 * nothing about HOW the row is written or HOW the dispatch fans out.
 * Consumers inject:
 *
 *   - `CommitTransport`  — writes the AgentJob row through the sync
 *                          engine (HTTP commit for Vercel routes,
 *                          in-process Ablo commit for the worker).
 *
 *   - `DispatchTransport` — wakes the worker fleet (SQS in prod,
 *                          in-memory or noop in tests).
 *
 * Both interfaces are intentionally tiny — the runtime composes them;
 * neither needs to know about the other.
 */

import type { AgentJobRecord, AgentJobSpec } from './types';

/** Result of a successful row commit. Shape mirrors Hub.commit response. */
export interface CommitReceipt {
  clientTxId: string;
  serverTxId: string;
  lastSyncId: number;
}

/**
 * Auth captured at the request boundary and threaded through every
 * transport call. Required because the producer dispatch can cross
 * AsyncLocalStorage boundaries (isolated-vm host callbacks, `after()`
 * queue work, worker threads), where reaching back into request-scoped
 * APIs (`next/headers`, `cookies()`) throws "outside a request scope".
 *
 * Always the raw HTTP `Cookie` header string, NOT a parsed dictionary —
 * matches `request.headers.get('cookie')` and `context.cookieHeader`
 * throughout the rest of the codebase.
 */
export interface TransportAuth {
  readonly cookieHeader: string;
}

export interface CommitTransport {
  /** Write an AgentJob row in `status: 'pending'`. Resolves with the receipt + id. */
  createRow(args: {
    spec: AgentJobSpec;
    jobId: string;
  }): Promise<{ jobId: string; receipt: CommitReceipt }>;

  /** Patch an existing AgentJob row. Used for SQS-failure compensation. */
  updateRow(args: {
    jobId: string;
    data: Record<string, unknown>;
    idempotencyKey: string;
    auth: TransportAuth;
  }): Promise<CommitReceipt>;

  /** Read the current AgentJob row. Used by `handle.wait` for polling. */
  retrieveRow(jobId: string, auth: TransportAuth): Promise<AgentJobRecord | null>;
}

export interface DispatchTransport {
  /**
   * Wake a worker for `jobId`. Throws on transport failure so the
   * runtime can compensate.
   *
   * `oidcToken` is the pre-resolved Vercel OIDC JWT, captured at the
   * request boundary and threaded down by the producer. Required for
   * the same reason as `TransportAuth.cookieHeader`: inside any
   * dispatch site that crosses AsyncLocalStorage (isolated-vm host
   * callback, `after()` queue work, worker thread), the lazy
   * `getVercelOidcToken()` call would fail with "missing
   * x-vercel-oidc-token header". The transport may ignore this on
   * non-Vercel environments (workers, dev) where credentials come
   * from the AWS SDK default chain.
   */
  dispatch(args: {
    jobId: string;
    organizationId: string;
    oidcToken?: string;
  }): Promise<void>;
}

/**
 * Aggregate runtime config. Injected once via `configureAgentRuntime`
 * at app boot; subsequent `agent.run(...)` calls read it via the
 * module-level resolver.
 */
export interface AgentRuntimeConfig {
  readonly commit: CommitTransport;
  readonly dispatch: DispatchTransport;
}
