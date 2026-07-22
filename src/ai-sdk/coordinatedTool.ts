/**
 * Turns a write to one of your models into a Vercel AI SDK tool that handles
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
 * import { coordinatedTool } from '@abloatai/ablo/ai-sdk';
 * import { z } from 'zod';
 *
 * const saveSection = coordinatedTool(ablo.documents, {
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
 * The {@link CoordinatedToolOptions.apply} function is the whole API: a pure
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
 *   sees a conflict. This requires the model's agent conflict policy to be
 *   `reject` (the default, or `agentsReject()`). A model that declares
 *   `agentsNotify()` holds the losing write instead of rejecting it, which
 *   defeats the reconcile loop — there, use `'claim'` or `'queue'`, or change the
 *   policy.
 *
 * - `'claim'` gives mutual exclusion. It takes a fail-fast claim; if another
 *   participant holds the row, it returns `{ status: 'claimed' }` and leaves the
 *   decision to retry up to the model. A visible signal serves the agent better
 *   than a hidden wait when it might spend its turn on something else. Works under
 *   any conflict policy.
 *
 * - `'queue'` serializes writers over stateless HTTP. The tool polls to acquire
 *   the claim until it is granted or `poll.timeoutMs` elapses, so the model calls
 *   once and the tool waits its turn. Ordering is approximate rather than strict
 *   first-in-first-out, which would require a persistent connection.
 */

import { tool } from 'ai';
import type { z } from 'zod';
import { AbloClaimedError, AbloNotFoundError } from '../transaction/errors.js';
import type {
  ClaimParams,
  ModelRetrieveParams,
  ModelUpdateParams,
} from '../client/createModelProxy.js';
import type { ModelUpdater, ContentionOptions } from '../transaction/resources/functionalUpdate.js';
import type { HeldClaim } from '../transaction/types/streams.js';

export type CoordinationStrategy = 'merge' | 'claim' | 'queue';

/** The structured result the tool hands back to the model (or the caller). */
export interface CoordinatedWriteResult<T> {
  /**
   * `'written'` means the change was saved. `'claimed'` means another participant
   * holds the row, so nothing was saved and the model should try again.
   * `'timeout'` means the `'queue'` strategy could not acquire the row within
   * `poll.timeoutMs`.
   */
  status: 'written' | 'claimed' | 'timeout';
  /** The reconciled row, on `'written'`. */
  row?: T;
  message?: string;
  /** On `'written'` via the `queue` strategy, how long the tool waited in line. */
  waitedMs?: number;
}

export interface CoordinatedToolOptions<TInput, T> {
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
  strategy?: CoordinationStrategy;
  /** Human-readable coordination metadata attached to the claim, used by the `'claim'` and `'queue'` strategies. */
  claim?: { description?: string };
  /** How many reconcile rounds `'merge'` may take before it gives up with `AbloContentionError`. */
  retries?: number;
  /** Poll interval and overall timeout for `'queue'`. Defaults to 250ms and 30s. */
  poll?: { intervalMs?: number; timeoutMs?: number };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The small model port this helper needs. Both typed transports implement this
 * exact contract; local-cache methods, wire receipts, and transport lifecycle
 * deliberately stay out of an AI tool's dependency surface.
 */
export interface CoordinatedModel<T> {
  retrieve(params: ModelRetrieveParams): Promise<T | undefined>;
  update(params: ModelUpdateParams<T>): Promise<T>;
  update(
    id: string,
    updater: ModelUpdater<T>,
    options?: ContentionOptions,
  ): Promise<T | undefined>;
  claim(params: ClaimParams<T>): Promise<HeldClaim<T>>;
}

export function coordinatedTool<
  TInput,
  T = Record<string, unknown>,
>(model: CoordinatedModel<T>, options: CoordinatedToolOptions<TInput, T>) {
  const strategy = options.strategy ?? 'merge';

  return tool<TInput, CoordinatedWriteResult<T>>({
    description: options.description,
    inputSchema: options.inputSchema,
    execute: async (input: TInput): Promise<CoordinatedWriteResult<T>> => {
      const id = options.id(input);

      if (strategy === 'merge') {
        // Read the freshest row, apply the patch, and commit it with a
        // compare-and-swap; on any concurrent write, re-read and re-apply with
        // backoff. The model never sees a conflict.
        const row = await model.update(id, (current) => options.apply(current, input), {
          retries: options.retries,
        });
        return { status: 'written', row: row ?? undefined };
      }

      // The 'claim' and 'queue' strategies both acquire a claim, write under it,
      // and release it. They differ only in what they do when the row is already
      // held: 'claim' returns a signal to the model, while 'queue' waits and
      // retries by polling to acquire.
      const acquireWriteRelease = async (): Promise<CoordinatedWriteResult<T>> => {
        const claim = await model.claim({
          id,
          queue: false,
          description: options.claim?.description,
        });
        try {
          const current = await model.retrieve({ id });
          if (current === undefined) {
            throw new AbloNotFoundError(
              `Cannot write ${id}: it does not exist (or is outside this credential's scope).`,
              [id],
            );
          }
          const row = await model.update({ id, data: options.apply(current, input), claim, wait: 'confirmed' });
          return { status: 'written', row };
        } finally {
          await claim.release();
        }
      };

      if (strategy === 'claim') {
        try {
          return await acquireWriteRelease();
        } catch (e) {
          if (e instanceof AbloClaimedError) {
            return { status: 'claimed', message: 'Another participant holds this row right now — it was NOT saved. Wait briefly and try again.' };
          }
          throw e;
        }
      }

      // strategy === 'queue': poll to acquire the claim over stateless HTTP.
      const interval = options.poll?.intervalMs ?? 250;
      const timeout = options.poll?.timeoutMs ?? 30_000;
      const start = Date.now();
      for (;;) {
        try {
          const result = await acquireWriteRelease();
          return { ...result, waitedMs: Date.now() - start };
        } catch (e) {
          if (e instanceof AbloClaimedError) {
            if (Date.now() - start >= timeout) {
              return { status: 'timeout', message: `Could not acquire the row within ${timeout}ms.` };
            }
            await sleep(interval);
            continue;
          }
          throw e;
        }
      }
    },
  });
}
