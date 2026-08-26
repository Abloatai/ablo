/**
 * Turns a write to one of your models into an AI SDK tool that handles
 * multi-agent coordination for you, so an agent can contribute to shared state
 * without silently overwriting another writer's concurrent change.
 *
 * The lower-level approach is to write your own `tool()` and call
 * `ablo.<model>.update({ id, data, claim })` inside its `execute` — the right
 * amount of control for a bespoke tool. This helper covers the common case
 * instead: the agent produced some content and you want to save it into a shared
 * row, without re-deriving optimistic concurrency each time. You declare the
 * write:
 *
 * ```ts
 * import { updateTool } from '@abloatai/ablo/ai-sdk';
 * import { z } from 'zod';
 *
 * const saveSection = updateTool(ablo.records, {
 *   description: 'Save your section into the shared document.',
 *   inputSchema: z.object({ text: z.string() }),
 *   id: () => DOC_ID,
 *   apply: (current, { text }) => ({ content: appendBlock(current.content, text) }),
 *   // strategy: 'merge'  ← the default
 * });
 *
 * await streamText({ model, messages, tools: { saveSection } });
 * ```
 *
 * The {@link UpdateToolOptions.apply} function is the whole API: a pure
 * function from the freshest row and the tool input to a patch, in the same
 * spirit as a functional state update. Everything beneath it — reading the latest
 * row, the compare-and-swap, backing off between retries, and releasing claims —
 * is the runtime's job.
 *
 * ## Strategies
 *
 * Choose a strategy by how you want concurrent writers to relate. Each is
 * designed to converge under many agents writing at once.
 *
 * - `'merge'` (the default) delegates to the functional update
 *   `ablo.<model>.update(id, current => apply(current, input))`. The runtime
 *   re-reads and re-applies `apply` on top of every concurrent write, backing off
 *   between rounds, so many agents accumulate into one row and the model never
 *   sees a conflict. Stale conditional writes always reject, which drives the
 *   reconcile loop. For long or side-effecting work, use `'claim'` or `'queue'`; otherwise change the
 *   policy.
 *
 * - `'claim'` gives mutual exclusion. It takes a fail-fast claim; if another
 *   participant holds the row, it returns `{ status: 'claimed' }` and leaves the
 *   decision to retry up to the model. A visible signal serves the agent better
 *   than a hidden wait when it might spend its turn on something else. Works under
 *   the fixed foreign-claim rejection rule.
 *
 * - `'queue'` joins Ablo's server-owned FIFO queue. The model calls once and
 *   the tool waits for the canonical claim grant; it does not recreate queueing
 *   with client-side polling.
 */

import { tool, type ToolExecutionOptions } from 'ai';
import type { z } from 'zod';
import type {
  ClaimSkipParams,
  ClaimParams,
  ModelUpdateParams,
} from '../client/resources/modelOperations.js';
import type { ModelUpdater, FunctionalUpdateOptions } from '../client/resources/functionalUpdate.js';
import type { HeldClaim } from '../types/streams.js';
import type { ModelToolOptions } from './toolOptions.js';

export type UpdateStrategy = 'merge' | 'claim' | 'queue';

/** The structured result the tool hands back to the model (or the caller). */
export interface UpdateToolResult<T> {
  /**
   * `'written'` means the change was saved. `'claimed'` means another participant
   * holds the row, so nothing was saved and the model should try again.
   */
  status: 'written' | 'claimed';
  /** The reconciled row, on `'written'`. */
  row?: T;
  message?: string;
  /** On `'written'` via the `queue` strategy, how long the tool waited. */
  waitedMs?: number;
}

export interface UpdateToolOptions<TInput, T>
  extends ModelToolOptions<TInput, UpdateToolResult<T>> {
  /** Tool description shown to the model. */
  description: string;
  /** The schema of what the model may send, as a standard AI SDK / Zod input schema. */
  inputSchema: z.ZodType<TInput>;
  /** Which row this write targets, derived from the tool input. */
  id: (input: TInput) => string;
  /**
   * Produces the write patch from the freshest current row and the tool input, as
   * a pure function of the two. Under `'merge'` it re-runs on top of every
   * concurrent write, so it must be idempotent with respect to its own
   * contribution — for example, skip its change when its marker is already
   * present — to stay correct across retries.
   */
  apply: (current: T, input: TInput) => Partial<T>;
  /** How concurrent writers relate. Defaults to `'merge'`. */
  strategy?: UpdateStrategy;
  /** Human-readable coordination metadata attached to the claim, used by the `'claim'` and `'queue'` strategies. */
  claim?: { description?: string };
  /** How many reconcile rounds `'merge'` may take before it gives up with `AbloContentionError`. */
  retries?: number;
}

/**
 * The small model port this helper needs. Both typed transports implement this
 * exact contract; local-cache methods, wire receipts, and transport lifecycle
 * deliberately stay out of an AI tool's dependency surface.
 */
export interface UpdateToolModel<T> {
  update(params: ModelUpdateParams<T>): Promise<T>;
  update(
    id: string,
    updater: ModelUpdater<T>,
    options?: FunctionalUpdateOptions,
  ): Promise<T | undefined>;
  claim(
    params: ClaimSkipParams<T>,
  ): Promise<HeldClaim<T> | null>;
  claim(params: ClaimParams<T>): Promise<HeldClaim<T>>;
}

export function updateTool<
  TInput,
  T = Record<string, unknown>,
>(model: UpdateToolModel<T>, options: UpdateToolOptions<TInput, T>) {
  const strategy = options.strategy ?? 'merge';

  return tool<TInput, UpdateToolResult<T>>({
    description: options.description,
    title: options.title,
    inputSchema: options.inputSchema,
    inputExamples: options.inputExamples,
    needsApproval: options.needsApproval,
    strict: options.strict,
    outputSchema: options.outputSchema,
    toModelOutput: options.toModelOutput,
    execute: async (
      input: TInput,
      execution: ToolExecutionOptions,
    ): Promise<UpdateToolResult<T>> => {
      const id = options.id(input);

      if (strategy === 'merge') {
        // Read the freshest row, apply the patch, and commit it with a
        // compare-and-swap; on any concurrent write, re-read and re-apply with
        // backoff. The model never sees a conflict.
        const row = await model.update(id, (current) => options.apply(current, input), {
          retries: options.retries,
          signal: execution.abortSignal,
        });
        return { status: 'written', row: row ?? undefined };
      }

      // The 'claim' and 'queue' strategies both acquire a claim, write under it,
      // and release it. They differ only in what they do when the row is already
      // held: 'claim' returns a signal to the model, while 'queue' waits for
      // the server-owned FIFO grant.
      const acquireWriteRelease = async (
        queue: boolean,
      ): Promise<UpdateToolResult<T>> => {
        const claim = await model.claim({
          id,
          queue,
          description: options.claim?.description,
          signal: execution.abortSignal,
        });
        if (!claim) {
          return {
            status: 'claimed',
            message:
              'Another participant holds this row right now — it was not saved.',
          };
        }
        try {
          const current = claim.data;
          const row = await model.update({
            id,
            data: options.apply(current, input),
            claim,
          });
          return { status: 'written', row };
        } finally {
          await claim.release();
        }
      };

      if (strategy === 'claim') {
        return acquireWriteRelease(false);
      }

      // The transaction client owns the server FIFO and resolves once granted.
      const start = Date.now();
      const result = await acquireWriteRelease(true);
      return { ...result, waitedMs: Date.now() - start };
    },
  });
}
