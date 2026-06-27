/**
 * `coordinatedTool` — the one-liner that turns an Ablo model write into a Vercel
 * AI SDK tool with multi-agent coordination already handled, so an AI agent can
 * contribute to shared state without ever silently clobbering a concurrent
 * writer.
 *
 * The base `./ai-sdk` pattern (see index.ts) is "write your own `tool()` and
 * call `ablo.<model>.update({ id, data, claim })` inside `execute`". That's the
 * right amount of control when a tool does something bespoke. But the *common*
 * case — "the agent produced some content; save it into the shared row" — should
 * not require every integration to re-derive optimistic concurrency by hand. This
 * collapses it to a declaration:
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
 * `apply` is the whole API: a pure function of `(freshest row, tool input) →
 * patch`, exactly like React's `setState(prev => next)`. Everything underneath —
 * reading the latest row, the compare-and-swap, the jittered backoff between
 * reconcile rounds, releasing claims — is the runtime's job, not yours.
 *
 * ## Strategies (pick by how writers should relate; all verified to converge
 * under N-way agent contention)
 *
 * - `'merge'` *(default)* — delegates straight to the functional update
 *   `ablo.<model>.update(id, current => apply(current, input))`. The SDK re-reads
 *   and re-applies `apply` on top of every concurrent write and backs off between
 *   rounds, so N agents *accumulate* into one row and the model never sees a
 *   conflict. **Requires the model's agent conflict policy to be `reject`** (the
 *   default, or `agentsReject()`); a model declaring `agentsNotify()` HOLDS the
 *   losing write instead of rejecting it, which defeats the reconcile — use
 *   `claim`/`queue` there, or switch the policy.
 *
 * - `'claim'` — mutual exclusion. Takes a fail-fast claim; if another participant
 *   holds the row it returns `{ status: 'claimed' }` so the *model* decides to
 *   retry (a legible signal beats a hidden wait when the agent might do something
 *   better with its turn). Works regardless of conflict policy.
 *
 * - `'queue'` — fair-ish serialization over stateless HTTP, the SQS shape: a
 *   client poll-acquire loop (true FIFO needs a socket) until the claim is granted
 *   or `poll.timeoutMs` elapses. The model calls once and the tool waits its turn.
 */

import { tool } from 'ai';
import type { z } from 'zod';
import { AbloClaimedError, AbloNotFoundError } from '../errors.js';
import type { ModelOperations } from '../client/createModelProxy.js';

export type CoordinationStrategy = 'merge' | 'claim' | 'queue';

/** The structured result the tool hands back to the model (or the caller). */
export interface CoordinatedWriteResult<T> {
  /**
   * `'written'` — saved. `'claimed'` — another participant holds the row; NOT
   * saved, the model should try again. `'timeout'` — the queue strategy could not
   * acquire the row within `poll.timeoutMs`.
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
  /** What the model may send — a normal AI SDK / zod input schema. */
  inputSchema: z.ZodType<TInput>;
  /** Which row this write targets, derived from the tool input. */
  id: (input: TInput) => string;
  /**
   * Produce the write patch from the freshest current row + the tool input — a
   * pure `(prev, input) => next`. Under `merge` it re-runs on every concurrent
   * write, so it must be idempotent w.r.t. its own contribution (e.g. skip if its
   * marker is already present) to be safe across reconcile rounds.
   */
  apply: (current: T, input: TInput) => Partial<T>;
  /** How concurrent writers relate. Defaults to `'merge'`. */
  strategy?: CoordinationStrategy;
  /** Human-legible coordination metadata attached to the claim (`claim`/`queue`). */
  claim?: { reason?: string; description?: string };
  /** Reconcile budget for `merge` (rounds before `AbloContentionError`). */
  retries?: number;
  /** Poll cadence / ceiling for `queue` (defaults 250ms / 30s). */
  poll?: { intervalMs?: number; timeoutMs?: number };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function coordinatedTool<
  TInput,
  T = Record<string, unknown>,
  CreateInput = Partial<T>,
>(model: ModelOperations<T, CreateInput>, options: CoordinatedToolOptions<TInput, T>) {
  const strategy = options.strategy ?? 'merge';

  return tool<TInput, CoordinatedWriteResult<T>>({
    description: options.description,
    inputSchema: options.inputSchema,
    execute: async (input: TInput): Promise<CoordinatedWriteResult<T>> => {
      const id = options.id(input);

      if (strategy === 'merge') {
        // The setState of the data layer: read fresh → apply → CAS → re-read +
        // re-apply with backoff on any concurrent write. Self-healing; the model
        // never sees a conflict. (Backoff lives in the shared reconcile loop.)
        const row = await model.update(id, (current) => options.apply(current, input), {
          retries: options.retries,
        });
        return { status: 'written', row: row ?? undefined };
      }

      // claim / queue both take a claim, write under it, and release. The only
      // difference is what they do when the row is already held: claim returns the
      // signal to the model; queue waits and retries (SQS-style poll-acquire).
      const acquireWriteRelease = async (): Promise<CoordinatedWriteResult<T>> => {
        const claim = await model.claim({
          id,
          queue: false,
          reason: options.claim?.reason,
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

      // strategy === 'queue': SQS-style poll-acquire over stateless HTTP.
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
