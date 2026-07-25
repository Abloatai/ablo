import { ModelScope, type InstanceCache } from '../InstanceCache.js';
import type { Model } from '../Model.js';
import type { ModelConstructor, QueryResult } from '../BaseSyncedStore.js';

export interface QueryOptions {
  predicate?: (model: Model) => boolean;
  state?: ModelScope;
  orderBy?: keyof Model;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export function queryByClass(
  objectPool: InstanceCache,
  pendingDeletes: ReadonlySet<string>,
  modelClass: ModelConstructor<Model>,
  options?: QueryOptions,
): QueryResult<Model> {
  const modelName = objectPool.registry.getModelNameFromConstructor(modelClass);
  if (!modelName) return { data: [], total: 0, hasMore: false };

  let models = objectPool
    .getByType(modelClass, options?.state ?? ModelScope.live)
    .filter((model) => !pendingDeletes.has(model.id));
  if (options?.predicate) models = models.filter(options.predicate);

  const total = models.length;
  if (options?.orderBy) {
    const field = options.orderBy as string;
    const direction = options.order === 'desc' ? -1 : 1;
    models.sort((a, b) => {
      const av = a.getField(field);
      const bv = b.getField(field);
      if (av == null || bv == null) return 0;
      return av < bv ? -direction : av > bv ? direction : 0;
    });
  }

  if (options?.offset) models = models.slice(options.offset);
  const hasMore = options?.limit ? models.length > options.limit : false;
  if (options?.limit) models = models.slice(0, options.limit);
  return { data: models, total, hasMore };
}

export function countModels(
  objectPool: InstanceCache,
  modelClass: ModelConstructor<Model>,
  pendingDeletes: ReadonlySet<string>,
  predicate?: (model: Model) => boolean,
): number {
  const models = objectPool
    .getByType(modelClass, ModelScope.live)
    .filter((model) => !pendingDeletes.has(model.id));
  return predicate ? models.filter(predicate).length : models.length;
}
