import { z } from 'zod';
import {
  updateTool,
  type UpdateToolModel,
  type UpdateToolResult,
} from '../updateTool.js';
import type {
  ModelUpdateParams,
} from '../../resources/modelOperations.js';
import type {
  ContentionOptions,
  ModelUpdater,
} from '@abloatai/transaction/resources/functionalUpdate';
import type { HeldClaim } from '@abloatai/transaction/types/streams';

// `ai` ships ESM/TS that Jest can't transform; updateTool only uses
// `tool()`, which is a pass-through that returns its definition (with `execute`).
jest.mock('ai', () => ({ tool: (def: unknown) => def }));

/**
 * Deterministic unit tests for `updateTool` — no engine, no LLM. A stub
 * model lets us assert the per-strategy control flow (which path writes, which
 * returns a signal) in isolation.
 */

interface Row { value: string }
const inputSchema = z.object({ value: z.string() });

/** A minimal, fully typed update model fixture. */
interface StubOverride {
  claim?: UpdateToolModel<Row>['claim'];
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

function stubModel(over: StubOverride): UpdateToolModel<Row> {
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
    update,
    claim: over.claim ?? (() => Promise.resolve(heldClaim())),
  };
}

/** Invoke a built tool's execute directly with minimal ToolCallOptions. */
async function run(
  model: UpdateToolModel<Row>,
  opts: Parameters<typeof updateTool<{ value: string }, Row>>[1],
  input: { value: string },
): Promise<UpdateToolResult<Row>> {
  const t = updateTool<{ value: string }, Row>(model, opts);
  const exec = t.execute;
  if (!exec) throw new Error('tool has no execute');
  const result = await exec(input, { toolCallId: 't', messages: [] });
  return result as UpdateToolResult<Row>;
}

const base = { description: 'save', inputSchema, id: () => 'row-1', apply: (_c: Row, i: { value: string }) => ({ value: i.value }) };

describe('updateTool', () => {
  it('merge: writes via the functional update and returns the reconciled row', async () => {
    const r = await run(stubModel({}), { ...base, strategy: 'merge' }, { value: 'v' });
    expect(r).toEqual({ status: 'written', row: { value: 'v' } });
  });

  it('claim: returns a "claimed" signal when the try-claim is declined', async () => {
    const r = await run(
      stubModel({
        claim: (() => Promise.resolve(null)) as UpdateToolModel<Row>['claim'],
      }),
      { ...base, strategy: 'claim' },
      { value: 'v' },
    );
    expect(r.status).toBe('claimed');
  });

  it('claim: writes under the claim when free', async () => {
    const r = await run(stubModel({}), { ...base, strategy: 'claim' }, { value: 'v' });
    expect(r).toMatchObject({ status: 'written', row: { value: 'v' } });
  });

  it('queue: delegates waiting to the transaction claim queue', async () => {
    const queueModes: boolean[] = [];
    const model = stubModel({
      claim: ((params: { queue?: boolean }) => {
        queueModes.push(params.queue ?? true);
        return Promise.resolve(heldClaim());
      }) as UpdateToolModel<Row>['claim'],
    });
    const r = await run(model, { ...base, strategy: 'queue' }, { value: 'v' });
    expect(r.status).toBe('written');
    expect(queueModes).toEqual([true]);
  });

  it('non-claim errors propagate (not swallowed as a coordination signal)', async () => {
    const boom = new Error('db down');
    await expect(
      run(
        stubModel({
          claim: (() => Promise.reject(boom)) as UpdateToolModel<Row>['claim'],
        }),
        { ...base, strategy: 'claim' },
        { value: 'v' },
      ),
    ).rejects.toThrow('db down');
  });
});
