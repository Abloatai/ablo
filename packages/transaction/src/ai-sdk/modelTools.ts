/**
 * Small AI SDK adapters for Ablo model resources.
 *
 * The AI SDK owns the agent loop. These helpers only expose Ablo's
 * authoritative model operations as tools, preserving the same credential,
 * validation, idempotency, claims, and confirmation behavior as direct SDK use.
 */

import { tool, type ToolExecutionOptions } from 'ai';
import type { z } from 'zod';
import type {
  ClaimParams,
  ClaimSkipParams,
  ModelCreateParams,
  ModelDeleteParams,
  ModelRetrieveParams,
} from '../resources/modelOperations.js';
import type { HeldClaim } from '../types/streams.js';
import type { ModelToolOptions } from './toolOptions.js';

export interface ToolModel<T, CreateInput = Partial<T>, Fields = T> {
  get(params: ModelRetrieveParams): Promise<T | undefined>;
  create(params: ModelCreateParams<T, CreateInput>): Promise<T>;
  delete(params: ModelDeleteParams<T, Fields>): Promise<void>;
  claim(
    params: ClaimSkipParams<Fields>,
  ): Promise<HeldClaim<T> | null>;
  claim(params: ClaimParams<Fields>): Promise<HeldClaim<T>>;
}

export interface ReadToolOptions<TInput, T>
  extends ModelToolOptions<TInput, ReadToolResult<T>> {
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly id: (input: TInput) => string;
}

export type ReadToolResult<T> =
  | { readonly status: 'found'; readonly row: T }
  | { readonly status: 'not_found'; readonly message: string };

export function readTool<TInput, T>(
  model: Pick<ToolModel<T>, 'get'>,
  options: ReadToolOptions<TInput, T>,
) {
  return tool<TInput, ReadToolResult<T>>({
    description: options.description,
    title: options.title,
    inputSchema: options.inputSchema,
    inputExamples: options.inputExamples,
    needsApproval: options.needsApproval,
    strict: options.strict,
    outputSchema: options.outputSchema,
    toModelOutput: options.toModelOutput,
    execute: async (input) => {
      const id = options.id(input);
      const row = await model.get({ id });
      return row === undefined
        ? {
            status: 'not_found',
            message: `No accessible row exists with id ${id}.`,
          }
        : { status: 'found', row };
    },
  });
}

export interface CreateToolOptions<TInput, CreateInput, T>
  extends ModelToolOptions<TInput, CreateToolResult<T>> {
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly data: (input: TInput) => CreateInput;
  /**
   * Stable ids make retries idempotent. Omit only when the model or server
   * generates the id and duplicate creation is acceptable to the application.
   */
  readonly id?: (input: TInput) => string | undefined;
}

export interface CreateToolResult<T> {
  readonly status: 'created';
  readonly row: T;
}

export function createTool<TInput, T, CreateInput>(
  model: Pick<ToolModel<T, CreateInput>, 'create'>,
  options: CreateToolOptions<TInput, CreateInput, T>,
) {
  return tool<TInput, CreateToolResult<T>>({
    description: options.description,
    title: options.title,
    inputSchema: options.inputSchema,
    inputExamples: options.inputExamples,
    needsApproval: options.needsApproval,
    strict: options.strict,
    outputSchema: options.outputSchema,
    toModelOutput: options.toModelOutput,
    execute: async (input) => {
      const id = options.id?.(input);
      const row = await model.create({
        data: options.data(input),
        ...(id !== undefined ? { id } : {}),
      });
      return { status: 'created', row };
    },
  });
}

export interface DeleteToolOptions<TInput>
  extends ModelToolOptions<TInput, DeleteToolResult> {
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly id: (input: TInput) => string;
  /** Defaults to waiting in the server-owned FIFO claim queue. */
  readonly strategy?: 'claim' | 'queue';
  readonly claim?: { readonly description?: string };
}

export type DeleteToolResult =
  | { readonly status: 'deleted'; readonly id: string }
  | { readonly status: 'claimed'; readonly message: string };

export function deleteTool<TInput, T, Fields = T>(
  model: Pick<ToolModel<T, Partial<T>, Fields>, 'claim' | 'delete'>,
  options: DeleteToolOptions<TInput>,
) {
  return tool<TInput, DeleteToolResult>({
    description: options.description,
    title: options.title,
    inputSchema: options.inputSchema,
    inputExamples: options.inputExamples,
    // Destructive tools require approval unless an application deliberately
    // opts into autonomous deletion.
    needsApproval: options.needsApproval ?? true,
    strict: options.strict,
    outputSchema: options.outputSchema,
    toModelOutput: options.toModelOutput,
    execute: async (
      input: TInput,
      execution: ToolExecutionOptions,
    ): Promise<DeleteToolResult> => {
      const id = options.id(input);
      const queue = options.strategy !== 'claim';
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
            'Another participant holds this row right now — it was not deleted.',
        };
      }
      try {
        await model.delete({ id, claim });
        return { status: 'deleted', id };
      } finally {
        await claim.release();
      }
    },
  });
}
