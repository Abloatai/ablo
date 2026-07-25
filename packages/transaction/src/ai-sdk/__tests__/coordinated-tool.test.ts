import { z } from 'zod';
import {
  coordinatedTool,
  type CoordinatedModel,
  type CoordinatedWriteResult,
} from '../coordinatedTool.js';
import { AbloClaimedError } from '@abloatai/transaction/errors';
import type {
  ModelUpdateParams,
} from '../../resources/modelOperations.js';
import type {
  ContentionOptions,
  ModelUpdater,
} from '@abloatai/transaction/resources/functionalUpdate';
import type { HeldClaim } from '@abloatai/transaction/types/streams';

// `ai` ships ESM/TS that Jest can't transform; coordinatedTool only uses
// `tool()`, which is a pass-through that returns its definition (with `execute`).
jest.mock('ai', () => ({ tool: (def: unknown) => def }));

/**
 * Deterministic unit tests for `coordinatedTool` — no engine, no LLM. A stub
 * model lets us assert the per-strategy control flow (which path writes, which
 * returns a signal, retry/timeout) in isolation. The probabilistic real-agent
 * version lives in the demo's `evals/coordinated-tool.ts`.
 */

interface Row { value: string }
const inputSchema = z.object({ value: z.string() });
const claimed = () => new AbloClaimedError('held', { code: 'claim_conflict', httpStatus: 409 });

/** A minimal, fully typed CoordinatedModel fixture. */
interface StubOverride {
  claim?: CoordinatedModel<Row>['claim'];
}

function heldClaim(): HeldClaim<Row> {
  const release = async (): Promise<void> => {};
  return {
    object: 'claim',
    id: 'claim-1',
    target: { type: 'Row', id: 'row-1' },
    description: 'test',
    data: { value: 'base' },
    release,
    revoke: () => {},
    heartbeat: () => Promise.resolve({ expiresAt: Date.now() + 1_000 }),
    [Symbol.asyncDispose]: release,
  };
}

function stubModel(over: StubOverride): CoordinatedModel<Row> {
  function update(params: ModelUpdateParams<Row>): Promise<Row>;
  function update(
    id: string,
    updater: ModelUpdater<Row>,
    options?: ContentionOptions,
  ): Promise<Row | undefined>;
  async function update(
    paramsOrId: ModelUpdateParams<Row> | string,
    updater?: ModelUpdater<Row>,
  ): Promise<Row | undefined> {
    if (typeof paramsOrId === 'string') {
      if (!updater) throw new Error('Functional update requires an updater');
      const patch = await updater({ value: 'base' });
      return patch ? { value: 'base', ...patch } : undefined;
    }
    return { value: 'base', ...paramsOrId.data };
  }

  return {
    get: () => Promise.resolve({ value: 'base' }),
    update,
    claim: over.claim ?? (() => Promise.resolve(heldClaim())),
  };
}

/** Invoke a built tool's execute directly with minimal ToolCallOptions. */
async function run(
  model: CoordinatedModel<Row>,
  opts: Parameters<typeof coordinatedTool<{ value: string }, Row>>[1],
  input: { value: string },
): Promise<CoordinatedWriteResult<Row>> {
  const t = coordinatedTool<{ value: string }, Row>(model, opts);
  const exec = t.execute;
  if (!exec) throw new Error('tool has no execute');
  const result = await exec(input, { toolCallId: 't', messages: [] });
  return result as CoordinatedWriteResult<Row>;
}

const base = { description: 'save', inputSchema, id: () => 'row-1', apply: (_c: Row, i: { value: string }) => ({ value: i.value }) };

describe('coordinatedTool', () => {
  it('merge: writes via the functional update and returns the reconciled row', async () => {
    const r = await run(stubModel({}), { ...base, strategy: 'merge' }, { value: 'v' });
    expect(r).toEqual({ status: 'written', row: { value: 'v' } });
  });

  it('claim: returns a "claimed" signal (not a throw) when the row is held', async () => {
    const r = await run(stubModel({ claim: () => Promise.reject(claimed()) }), { ...base, strategy: 'claim' }, { value: 'v' });
    expect(r.status).toBe('claimed');
  });

  it('claim: writes under the claim when free', async () => {
    const r = await run(stubModel({}), { ...base, strategy: 'claim' }, { value: 'v' });
    expect(r).toMatchObject({ status: 'written', row: { value: 'v' } });
  });

  it('queue: poll-acquires past contention, then writes', async () => {
    let attempts = 0;
    const model = stubModel({
      claim: () => {
        if (attempts++ < 2) return Promise.reject(claimed());
        return Promise.resolve(heldClaim());
      },
    });
    const r = await run(model, { ...base, strategy: 'queue', poll: { intervalMs: 1, timeoutMs: 1000 } }, { value: 'v' });
    expect(r.status).toBe('written');
    expect(attempts).toBe(3); // two conflicts, third grants
  });

  it('queue: gives up with "timeout" when never granted within the budget', async () => {
    const r = await run(
      stubModel({ claim: () => Promise.reject(claimed()) }),
      { ...base, strategy: 'queue', poll: { intervalMs: 1, timeoutMs: 5 } },
      { value: 'v' },
    );
    expect(r.status).toBe('timeout');
  });

  it('non-claim errors propagate (not swallowed as a coordination signal)', async () => {
    const boom = new Error('db down');
    await expect(run(stubModel({ claim: () => Promise.reject(boom) }), { ...base, strategy: 'claim' }, { value: 'v' })).rejects.toThrow('db down');
  });
});
