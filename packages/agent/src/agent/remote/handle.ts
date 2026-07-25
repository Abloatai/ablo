/**
 * AgentJobHandle — returned by `agent.run(spec)`.
 *
 * Wraps a dispatched AgentJob row with caller-friendly `wait` /
 * `cancel` helpers. `wait` distinguishes:
 *
 *   - terminal status     → resolves with `AgentJobRecord`
 *   - past terminal budget → throws `AgentJobWaitTimeoutError`
 *   - never-claimed       → throws `AgentJobDispatchLostError` (no
 *                            worker picked it up — producer-side fault)
 *
 * The handle holds a reference to the `CommitTransport` so polling
 * uses the same authenticated channel that created the row.
 */

import type { CommitTransport, TransportAuth } from './transport';
import {
  AgentJobDispatchLostError,
  AgentJobWaitTimeoutError,
  isTerminalAgentJobStatus,
  type AgentJobRecord,
  type WaitOptions,
} from './types';

export interface AgentJobHandle {
  readonly jobId: string;
  readonly organizationId: string;

  /**
   * Block until the row reaches a terminal status. See `WaitOptions`
   * for budget shape. Resolves with the final `AgentJobRecord`.
   */
  wait(opts?: WaitOptions): Promise<AgentJobRecord>;

  /**
   * Cooperative cancellation — sets `status: 'cancelling'` on the row
   * so the worker sees it on its next checkpoint and exits.
   */
  cancel(): Promise<void>;
}

interface BuildHandleArgs {
  readonly jobId: string;
  readonly organizationId: string;
  readonly commit: CommitTransport;
  readonly auth: TransportAuth;
}

export function buildAgentJobHandle(args: BuildHandleArgs): AgentJobHandle {
  const { jobId, organizationId, commit, auth } = args;

  async function wait(opts: WaitOptions = {}): Promise<AgentJobRecord> {
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const intervalMs = opts.intervalMs ?? 1_000;
    const dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 30_000;
    const start = Date.now();
    let leftPendingAt: number | null = null;

    while (Date.now() - start < timeoutMs) {
      const row = await commit.retrieveRow(jobId, auth);
      if (!row) {
        throw new Error(`AgentJob ${jobId} was not found`);
      }
      if (isTerminalAgentJobStatus(row.status as string)) return row;
      if (row.status !== 'pending' && leftPendingAt === null) {
        leftPendingAt = Date.now();
      }
      if (leftPendingAt === null && Date.now() - start >= dispatchTimeoutMs) {
        throw new AgentJobDispatchLostError(jobId, dispatchTimeoutMs);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new AgentJobWaitTimeoutError(jobId, timeoutMs);
  }

  async function cancel(): Promise<void> {
    await commit.updateRow({
      jobId,
      idempotencyKey: `agent-job:cancel:${jobId}`,
      data: { status: 'cancelling' },
      auth,
    });
  }

  return { jobId, organizationId, wait, cancel };
}
