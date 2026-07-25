/**
 * `agent.run(spec)` — the producer-side primitive.
 *
 * Two responsibilities, atomically paired:
 *
 *   1. Write the AgentJob row through the injected `CommitTransport`.
 *   2. Wake the worker fleet through the injected `DispatchTransport`.
 *
 * If step 2 fails, the row is compensated to `status: 'failed'` so it
 * doesn't linger as `pending` forever, and `AgentJobEnqueueError` is
 * thrown. The handle returned only escapes if both steps succeeded.
 *
 * Distinct from the supervisor's `agent.run({description, prompt, ...})`
 * inside execute-sandbox — that's the LLM-facing in-process verb on the
 * `agent/in-process` runtime. They share the verb (running an agent) but
 * sit at different layers; the cognitive model is the same, the shapes
 * are not.
 */

import { randomUUID } from 'node:crypto';
import { buildAgentJobHandle, type AgentJobHandle } from './handle';
import type { AgentRuntimeConfig } from './transport';
import {
  AgentJobEnqueueError,
  type AgentJobRecord,
  type AgentJobSpec,
  type WaitOptions,
} from './types';

let runtimeConfig: AgentRuntimeConfig | null = null;

/**
 * Wire the transports for `agent.run(...)`. Idempotent — calling again
 * replaces the config. Producer routes import a boot module that calls
 * this once at module load; HMR-driven re-evaluation is safe.
 */
export function configureAgentRuntime(config: AgentRuntimeConfig): void {
  runtimeConfig = config;
}

/** Returns true once `configureAgentRuntime(...)` has been called. */
export function isAgentRuntimeConfigured(): boolean {
  return runtimeConfig !== null;
}

/** Test/dev escape hatch — clears the runtime so tests can re-configure. */
export function resetAgentRuntimeForTests(): void {
  runtimeConfig = null;
}

function requireRuntime(): AgentRuntimeConfig {
  if (!runtimeConfig) {
    throw new Error(
      'agent.run: runtime not configured — call configureAgentRuntime(...) at app boot',
    );
  }
  return runtimeConfig;
}

async function runAgent(spec: AgentJobSpec): Promise<AgentJobHandle> {
  const { commit, dispatch } = requireRuntime();
  const jobId = spec.jobId ?? randomUUID();

  await commit.createRow({ spec, jobId });

  try {
    await dispatch.dispatch({
      jobId,
      organizationId: spec.organizationId,
      oidcToken: spec.auth.oidcToken,
    });
  } catch (err) {
    // Compensate so dispatch-lost detection in handle.wait() doesn't
    // have to wait it out, and observers see the row flip to terminal
    // immediately. Best-effort — propagate the original cause.
    try {
      await commit.updateRow({
        jobId,
        idempotencyKey: `agent-job:dispatch-failed:${jobId}`,
        data: {
          status: 'failed',
          error: `Dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        auth: spec.auth,
      });
    } catch {
      // swallow — the original dispatch error is the load-bearing one
    }
    throw new AgentJobEnqueueError(jobId, err);
  }

  return buildAgentJobHandle({
    jobId,
    organizationId: spec.organizationId,
    commit,
    auth: spec.auth,
  });
}

/**
 * Wait on an AgentJob row by id. Equivalent to building a handle from
 * the row and calling `.wait(...)` — convenience for callers that only
 * have the jobId (e.g. resumed turns where the original handle was
 * dropped between supervisor invocations).
 */
async function waitForAgent(
  jobId: string,
  auth: { cookieHeader: string },
  opts?: WaitOptions,
): Promise<AgentJobRecord> {
  const { commit } = requireRuntime();
  return buildAgentJobHandle({ jobId, organizationId: '', commit, auth }).wait(opts);
}

/**
 * Read an AgentJob row by id without polling. Returns the current row
 * snapshot — caller decides what to do based on `status`. Use for
 * "is it done yet?" lookups when you don't want to block. Returns
 * `null` if the row doesn't exist.
 */
async function readAgent(
  jobId: string,
  auth: { cookieHeader: string },
): Promise<AgentJobRecord | null> {
  const { commit } = requireRuntime();
  return commit.retrieveRow(jobId, auth);
}

/** Cooperative cancel by jobId. */
async function cancelAgent(
  jobId: string,
  auth: { cookieHeader: string },
): Promise<void> {
  const { commit } = requireRuntime();
  return buildAgentJobHandle({ jobId, organizationId: '', commit, auth }).cancel();
}

/**
 * The producer surface. Import once, call from any producer route or
 * in-process call site.
 *
 *   const handle = await agent.run({ plugin: 'subagent', ... });
 *   const row    = await handle.wait({ timeoutMs: 90_000 });
 *
 * Or, when you only kept the jobId between turns:
 *
 *   const row = await agent.wait(jobId, { cookieHeader }, { timeoutMs: 90_000 });
 *   await agent.cancel(jobId, { cookieHeader });
 */
export const agent = {
  run: runAgent,
  wait: waitForAgent,
  read: readAgent,
  cancel: cancelAgent,
} as const;
