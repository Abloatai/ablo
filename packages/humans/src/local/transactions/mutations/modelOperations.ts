import type { WriteOptions } from '../../interfaces/index.js';
import type { LocalModel as Model } from '../../localModelContract.js';
import type { QueuedMutation, UserContext, MutationInput } from './commitPayload.js';

export interface ModelMutationContext {
  readonly enableOptimistic: boolean;
  readonly persistenceReady: boolean;
  readonly assertDurableReplayOpen: () => void;
  readonly generateId: () => string;
  readonly normalizeModelKey: (modelName: string) => string;
  readonly computePriorityScore: (type: QueuedMutation['type'], modelName: string) => number;
  readonly extractCreateData: (model: Model) => Record<string, unknown>;
  readonly extractUpdateData: (model: Model) => MutationInput;
  readonly extractPreviousData: (model: Model, input: MutationInput) => Record<string, unknown> | null;
  readonly mapChangesToInput: (modelName: string, changes: Record<string, unknown>) => MutationInput;
  readonly isReorderPayload: (input: MutationInput) => boolean;
  readonly attachConfirmation: (transaction: QueuedMutation) => void;
  readonly add: (transaction: QueuedMutation) => void;
  readonly applyOptimisticCreate: (model: Model, transaction: QueuedMutation) => void;
  readonly applyOptimisticUpdate: (model: Model, transaction: QueuedMutation) => void;
  readonly applyOptimisticDelete: (model: Model, transaction: QueuedMutation) => void;
  readonly takeUnsentCreateForModel: (modelName: string, modelId: string) => QueuedMutation | undefined;
  readonly cancelUnsentCreateForDelete: (transaction: QueuedMutation) => Promise<void>;
  readonly completeLocalDelete: (model: Model, context: UserContext, writeOptions?: WriteOptions, sourceMutationIds?: string[]) => QueuedMutation | Promise<QueuedMutation>;
  readonly cancelTransactionsForModel: (modelId: string, type: 'update') => QueuedMutation[];
  readonly pendingMergeByModel: Map<string, { data: MutationInput; sourceMutationIds: string[] }>;
  readonly inFlightByModel: Set<string>;
  readonly findCreateBarrierForDelete: (modelName: string, modelId: string) => QueuedMutation | undefined;
  readonly deferDeleteUntilCreateSettles: (create: QueuedMutation, transaction: QueuedMutation) => void;
  readonly logger: { debug: (message: string, fields?: Record<string, string>) => void };
  readonly persistAndStage: (transaction: QueuedMutation, modelData: Record<string, unknown>) => Promise<void>;
  readonly persistQueuedTransaction: (transaction: QueuedMutation, modelData: Record<string, unknown>) => Promise<void>;
  readonly stageTransaction: (transaction: QueuedMutation) => void;
  readonly emit: (event: string, payload: object) => void;
}

export async function remove(
  ctx: ModelMutationContext,
  model: Model,
  context: UserContext,
  writeOptions?: WriteOptions,
  sourceMutationId?: string,
): Promise<QueuedMutation> {
  ctx.assertDurableReplayOpen();
  const modelName = model.getModelName();
  if (modelName === 'Activity') {
    ctx.logger.debug('MutationQueue.delete() skipping Activity deletion - permanent audit records', { modelId: model.id });
    const transaction: QueuedMutation = {
      id: ctx.generateId(), type: 'delete', modelName, modelId: model.id,
      modelKey: ctx.normalizeModelKey(modelName), priorityScore: ctx.computePriorityScore('delete', modelName),
      previousData: model.toJSON(), context, status: 'completed', createdAt: Date.now(), attempts: 0,
      priority: 'high', writeOptions, localOnly: true, confirmation: Promise.resolve(),
      ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
    };
    if (ctx.persistenceReady) transaction.sourceMutationIds ??= [transaction.id];
    if (ctx.enableOptimistic) ctx.applyOptimisticDelete(model, transaction);
    ctx.emit('transaction:created', transaction);
    ctx.emit('transaction:completed', transaction);
    return transaction;
  }

  const unsentCreate = ctx.takeUnsentCreateForModel(modelName, model.id);
  if (unsentCreate) {
    await ctx.cancelUnsentCreateForDelete(unsentCreate);
    return ctx.completeLocalDelete(model, context, writeOptions, [
      ...(unsentCreate.sourceMutationIds ?? []),
      ...(sourceMutationId ? [sourceMutationId] : []),
    ]);
  }

  const transaction: QueuedMutation = {
    id: ctx.generateId(), type: 'delete', modelName, modelId: model.id,
    modelKey: ctx.normalizeModelKey(modelName), priorityScore: ctx.computePriorityScore('delete', modelName),
    previousData: model.toJSON(), context, status: 'pending', createdAt: Date.now(), attempts: 0,
    priority: 'high', writeOptions,
    ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
  };
  if (ctx.persistenceReady) transaction.sourceMutationIds ??= [transaction.id];
  ctx.attachConfirmation(transaction);
  ctx.add(transaction);
  const canceledUpdates = ctx.cancelTransactionsForModel(model.id, 'update');
  const key = `${modelName}:${model.id}`;
  const pendingMerge = ctx.pendingMergeByModel.get(key);
  transaction.sourceMutationIds = [...new Set([
    ...(transaction.sourceMutationIds ?? []),
    ...canceledUpdates.flatMap((candidate) => candidate.commitEnvelope ? [] : (candidate.sourceMutationIds ?? [])),
    ...(pendingMerge?.sourceMutationIds ?? []),
  ])];
  ctx.pendingMergeByModel.delete(key);
  ctx.inFlightByModel.delete(key);
  if (ctx.enableOptimistic) ctx.applyOptimisticDelete(model, transaction);
  await ctx.persistQueuedTransaction(transaction, model.toJSON());
  const createBarrier = ctx.findCreateBarrierForDelete(modelName, model.id);
  if (createBarrier) ctx.deferDeleteUntilCreateSettles(createBarrier, transaction);
  else ctx.stageTransaction(transaction);
  ctx.emit('transaction:created', transaction);
  return transaction;
}

function stage(ctx: ModelMutationContext, transaction: QueuedMutation, model: Model): Promise<void> | void {
  return ctx.persistenceReady
    ? ctx.persistAndStage(transaction, model.toJSON())
    : ctx.stageTransaction(transaction);
}

export function create(
  ctx: ModelMutationContext,
  model: Model,
  context: UserContext,
  writeOptions?: WriteOptions,
  sourceMutationId?: string,
): Promise<QueuedMutation> | QueuedMutation {
  ctx.assertDurableReplayOpen();
  const modelName = model.getModelName();
  const transaction: QueuedMutation = {
    id: ctx.generateId(), type: 'create', modelName, modelId: model.id,
    modelKey: ctx.normalizeModelKey(modelName),
    priorityScore: ctx.computePriorityScore('create', modelName),
    data: ctx.extractCreateData(model), previousData: null, context,
    status: 'pending', createdAt: Date.now(), attempts: 0, priority: 'normal', writeOptions,
    ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
  };
  if (ctx.persistenceReady) transaction.sourceMutationIds ??= [transaction.id];
  ctx.attachConfirmation(transaction);
  ctx.add(transaction);
  if (ctx.enableOptimistic) ctx.applyOptimisticCreate(model, transaction);
  const staged = stage(ctx, transaction, model);
  if (staged) return staged.then(() => { ctx.emit('transaction:created', transaction); return transaction; });
  ctx.emit('transaction:created', transaction);
  return transaction;
}

export function update(
  ctx: ModelMutationContext,
  model: Model,
  context: UserContext,
  precomputedChanges?: Record<string, unknown>,
  writeOptions?: WriteOptions,
  sourceMutationId?: string,
): Promise<QueuedMutation> | QueuedMutation {
  ctx.assertDurableReplayOpen();
  const modelName = model.getModelName();
  const input = precomputedChanges
    ? ctx.mapChangesToInput(modelName, precomputedChanges)
    : ctx.extractUpdateData(model);
  const previousData = ctx.extractPreviousData(model, input);
  model.consumeModifiedFields(Object.keys(input));
  const transaction: QueuedMutation = {
    id: ctx.generateId(), type: 'update', modelName, modelId: model.id,
    modelKey: ctx.normalizeModelKey(modelName),
    priorityScore: ctx.computePriorityScore('update', modelName),
    data: input, previousData, context, status: 'pending', createdAt: Date.now(), attempts: 0,
    priority: ctx.isReorderPayload(input) ? 'high' : 'normal', writeOptions,
    ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
  };
  if (ctx.persistenceReady) transaction.sourceMutationIds ??= [transaction.id];
  ctx.attachConfirmation(transaction);
  ctx.add(transaction);
  if (ctx.enableOptimistic) ctx.applyOptimisticUpdate(model, transaction);
  const staged = stage(ctx, transaction, model);
  if (staged) return staged.then(() => { ctx.emit('transaction:created', transaction); return transaction; });
  ctx.emit('transaction:created', transaction);
  return transaction;
}

export function archive(
  ctx: ModelMutationContext,
  model: Model,
  context: UserContext,
  writeOptions?: WriteOptions,
  sourceMutationId?: string,
): Promise<QueuedMutation> | QueuedMutation {
  return simpleStatusMutation(ctx, 'archive', model, context, writeOptions, sourceMutationId);
}

export function unarchive(
  ctx: ModelMutationContext,
  model: Model,
  context: UserContext,
): Promise<QueuedMutation> | QueuedMutation {
  return simpleStatusMutation(ctx, 'unarchive', model, context);
}

function simpleStatusMutation(
  ctx: ModelMutationContext,
  type: 'archive' | 'unarchive',
  model: Model,
  context: UserContext,
  writeOptions?: WriteOptions,
  sourceMutationId?: string,
): Promise<QueuedMutation> | QueuedMutation {
  ctx.assertDurableReplayOpen();
  const modelName = model.getModelName();
  const transaction: QueuedMutation = {
    id: ctx.generateId(), type, modelName, modelId: model.id,
    modelKey: ctx.normalizeModelKey(modelName),
    priorityScore: ctx.computePriorityScore(type, modelName),
    previousData: model.toJSON(), context, status: 'pending', createdAt: Date.now(), attempts: 0,
    priority: 'normal',
    ...(writeOptions ? { writeOptions } : {}),
    ...(sourceMutationId ? { sourceMutationIds: [sourceMutationId] } : {}),
  };
  if (ctx.persistenceReady) transaction.sourceMutationIds ??= [transaction.id];
  ctx.attachConfirmation(transaction);
  ctx.add(transaction);
  const staged = stage(ctx, transaction, model);
  if (staged) return staged.then(() => { ctx.emit('transaction:created', transaction); return transaction; });
  ctx.emit('transaction:created', transaction);
  return transaction;
}
