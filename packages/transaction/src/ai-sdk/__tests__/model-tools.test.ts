import { z } from 'zod';
import type { HeldClaim } from '../../types/streams.js';
import {
  createTool,
  deleteTool,
  readTool,
  type ToolModel,
} from '../modelTools.js';

jest.mock('ai', () => ({ tool: (definition: unknown) => definition }));

interface Row {
  id: string;
  title: string;
}

type Model = ToolModel<Row, { title: string }>;

function claim(id = 'row-1'): HeldClaim<Row> {
  const release = jest.fn(async () => {});
  return {
    object: 'claim',
    id: 'claim-1',
    target: { type: 'Row', id },
    description: 'deleting obsolete row',
    data: { id, title: 'old' },
    release,
    revoke: () => {},
    heartbeat: async () => ({ expiresAt: Date.now() + 1_000 }),
    [Symbol.asyncDispose]: release,
  };
}

async function execute<TInput, TResult>(
  built: {
    execute?: (
      input: TInput,
      options: {
        toolCallId: string;
        messages: [];
        abortSignal?: AbortSignal;
      },
    ) => PromiseLike<TResult> | TResult;
  },
  input: TInput,
  abortSignal?: AbortSignal,
): Promise<TResult> {
  if (!built.execute) throw new Error('tool has no execute');
  return built.execute(input, {
    toolCallId: 'call-1',
    messages: [],
    abortSignal,
  });
}

describe('Ablo model AI SDK tools', () => {
  it('reads through the authoritative model get', async () => {
    const get = jest.fn(async ({ id }: { id: string }) => ({
      id,
      title: 'Current',
    }));
    const built = readTool(
      { get },
      {
        description: 'Read a row',
        inputSchema: z.object({ id: z.string() }),
        id: (input) => input.id,
      },
    );

    await expect(execute(built, { id: 'row-1' })).resolves.toEqual({
      status: 'found',
      row: { id: 'row-1', title: 'Current' },
    });
    expect(get).toHaveBeenCalledWith({ id: 'row-1' });
  });

  it('uses a caller-derived stable id for idempotent creation', async () => {
    const create = jest.fn(
      async (params: { id?: string | null; data: { title: string } }) => ({
        id: params.id ?? 'generated',
        ...params.data,
      }),
    );
    const built = createTool(
      { create },
      {
        description: 'Create a row',
        inputSchema: z.object({ id: z.string(), title: z.string() }),
        id: (input) => input.id,
        data: (input) => ({ title: input.title }),
      },
    );

    await execute(built, { id: 'row-1', title: 'New' });
    expect(create).toHaveBeenCalledWith({
      id: 'row-1',
      data: { title: 'New' },
    });
  });

  it('deletes under a claim and always releases it', async () => {
    const held = claim();
    const abort = new AbortController();
    const model = {
      claim: jest.fn(async () => held),
      delete: jest.fn(async () => undefined),
    } as Pick<Model, 'claim' | 'delete'>;
    const built = deleteTool(
      model,
      {
        description: 'Delete a row',
        inputSchema: z.object({ id: z.string() }),
        id: (input) => input.id,
      },
    );

    await expect(execute(built, { id: 'row-1' }, abort.signal)).resolves.toEqual({
      status: 'deleted',
      id: 'row-1',
    });
    expect(model.claim).toHaveBeenCalledWith({
      id: 'row-1',
      queue: true,
      description: undefined,
      signal: abort.signal,
    });
    expect(model.delete).toHaveBeenCalledWith({
      id: 'row-1',
      claim: held,
    });
    expect(held.release).toHaveBeenCalledTimes(1);
  });

  it('requires approval for deletion unless the application opts out', () => {
    const model = {
      claim: jest.fn(),
      delete: jest.fn(),
    } as Pick<Model, 'claim' | 'delete'>;
    const common = {
      description: 'Delete a row',
      inputSchema: z.object({ id: z.string() }),
      id: (input: { id: string }) => input.id,
    };

    expect(deleteTool(model, common).needsApproval).toBe(true);
    expect(
      deleteTool(model, { ...common, needsApproval: false }).needsApproval,
    ).toBe(false);
  });

  it('does not delete when a fail-fast claim is declined', async () => {
    const model = {
      claim: jest.fn(async () => null),
      delete: jest.fn(async () => undefined),
    } as Pick<Model, 'claim' | 'delete'>;
    const built = deleteTool(
      model,
      {
        description: 'Delete a row',
        inputSchema: z.object({ id: z.string() }),
        id: (input) => input.id,
        strategy: 'claim',
      },
    );

    await expect(execute(built, { id: 'row-1' })).resolves.toMatchObject({
      status: 'claimed',
    });
    expect(model.delete).not.toHaveBeenCalled();
  });
});
