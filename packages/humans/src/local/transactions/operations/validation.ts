import { PropertyType } from '@abloatai/transaction/types';
import { AbloValidationError } from '@abloatai/transaction/errors';
import type { Model } from '../../Model.js';
import type { ModelRegistry } from '../../ModelRegistry.js';

/** Ordinary and semantic writes validate the materialized model before queueing. */
export function validateModelWrite(model: Model, registry: Pick<ModelRegistry, 'getPropertiesForModel'>): void {
  const modelName = model.getModelName();
  const data = model.toJSON();
  for (const [field, metadata] of registry.getPropertiesForModel(modelName)) {
    if (metadata.type === PropertyType.referenceModel || metadata.type === PropertyType.ephemeralProperty) continue;
    if (!metadata.optional && (data[field] === null || data[field] === undefined)) {
      throw new AbloValidationError(`Required field ${field} is missing on ${modelName}`, { code: 'model_required_field_missing' });
    }
  }
}
