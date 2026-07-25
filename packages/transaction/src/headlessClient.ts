import {
  createAbloHttpClient,
  type AbloHttpClient,
  type AbloHttpClientOptions,
} from './transport/httpClient.js';
import { createHttpFeed } from './transport/httpFeed.js';
import type { SchemaRecord } from './schema/schema.js';
import { fieldRef } from './schema/fieldRef.js';
import type { ClaimParams, ServerReadOptions } from './resources/modelOperations.js';
import type { ModelData } from './types/modelData.js';
import type { ClaimLeaseOptions, ClaimTarget, HeldClaim } from './types/streams.js';
import type { CommitMessage } from './wire/frames.js';
import type {
  CommitReceipt,
  ListQuery,
  TransactionLayer,
} from './transactionLayer.js';
import { AbloConnectionError } from './errors.js';

export interface TransactionClientOptions<S extends SchemaRecord>
  extends AbloHttpClientOptions<S> {}

export type TransactionClient<S extends SchemaRecord> =
  TransactionLayer
  & AbloHttpClient<S>
  & { dispose(): Promise<void> };

type DynamicModel = {
  get(options: { id: string }): Promise<ModelData | undefined>;
  list(options?: ServerReadOptions<ModelData>): Promise<ModelData[]>;
  claim(options: ClaimParams<ModelData>): Promise<HeldClaim>;
};

const LAYER_MEMBERS = new Set<PropertyKey>([
  'ready',
  'get',
  'list',
  'commit',
  'settled',
  'claim',
  'observe',
  'dispose',
]);

function toCommitOptions(payload: CommitMessage['payload']) {
  return {
    idempotencyKey: payload.clientTxId,
    operations: payload.operations.map((operation) => ({
      action: operation.type.toLowerCase() as
        | 'create'
        | 'update'
        | 'delete'
        | 'archive'
        | 'unarchive',
      model: operation.model,
      id: operation.id,
      data: operation.input,
      readAt: operation.readAt,
      onStale: operation.onStale,
      transactionId: operation.transactionId,
      fenceToken: operation.fenceToken,
    })),
    reads: payload.reads,
    track: payload.track,
  } as const;
}

export function createTransactionClient<S extends SchemaRecord>(
  options: TransactionClientOptions<S>,
): TransactionClient<S> {
  const http = createAbloHttpClient(options);
  const pending = new Map<string, ReturnType<typeof toCommitOptions>>();
  const observe = createHttpFeed(http.logs);
  const hasDurableWrites =
    options.durableWrites !== undefined || options.commitOutbox !== undefined;

  function model(name: string): DynamicModel {
    const resource = Reflect.get(http, name) as DynamicModel | undefined;
    if (!resource) {
      throw new AbloConnectionError(`Unknown schema model: ${name}.`, {
        code: 'invalid_options',
      });
    }
    return resource;
  }

  const layer: TransactionLayer & { dispose(): Promise<void> } = {
    ready: () => http.ready(),
    async get(modelName, id) {
      return (await model(modelName).get({ id })) ?? null;
    },
    list(modelName, query?: ListQuery) {
      return model(modelName).list({
        ...(query?.where ? { where: query.where } : {}),
        ...(query?.orderBy ? { orderBy: query.orderBy } : {}),
        ...(query?.limit !== undefined ? { limit: query.limit } : {}),
        ...(query?.offset !== undefined ? { offset: query.offset } : {}),
        ...(query?.state !== undefined ? { state: query.state } : {}),
      });
    },
    async commit(payload) {
      const request = toCommitOptions(payload);
      pending.set(payload.clientTxId, request);
      const receipt = await http.commits.create({ ...request, wait: 'queued' });
      return { ...receipt, clientTxId: payload.clientTxId };
    },
    async settled(receipt) {
      if (receipt.status === 'confirmed') return;
      const request = pending.get(receipt.clientTxId);
      if (!request) {
        if (hasDurableWrites) {
          await http.waitForFlush();
          return;
        }
        throw new AbloConnectionError(
          'The original commit request is not available. Configure durableWrites to settle queued receipts after a process restart.',
          { code: 'commit_no_result' },
        );
      }
      const result = await http.commits.create({ ...request, wait: 'confirmed' });
      if (result.status !== 'confirmed') {
        throw new AbloConnectionError('The commit remains queued.', {
          code: 'replication_lag_timeout',
        });
      }
      pending.delete(receipt.clientTxId);
    },
    claim(target: ClaimTarget, claimOptions?: ClaimLeaseOptions) {
      return model(target.type).claim({
        id: target.id,
        ...(target.field
          ? { fields: () => fieldRef(target.type, target.field!) }
          : target.fields
            ? {
                fields: () =>
                  target.fields!.map((field) => fieldRef(target.type, field)) as [
                    ReturnType<typeof fieldRef>,
                    ...ReturnType<typeof fieldRef>[],
                  ],
              }
            : {}),
        ...(target.meta ? { meta: target.meta } : {}),
        ...claimOptions,
      });
    },
    observe,
    dispose: () => http.dispose(),
  };

  return new Proxy(layer as TransactionClient<S>, {
    get(target, property, receiver) {
      if (LAYER_MEMBERS.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      return Reflect.get(http, property);
    },
    has(target, property) {
      return Reflect.has(target, property) || Reflect.has(http, property);
    },
  });
}
