import type { Model } from '../../Model.js';
import type { QueuedMutation } from '../mutations/commitPayload.js';
import { toEpochMs } from '../../syncClientTypes.js';

/** Accepted rows and the primary mutation queue materialize one observable row. */
export function projectModelRow(model: Model, server: Record<string, unknown>, pending: readonly QueuedMutation[], projection?: Record<string, unknown>): Model {
  if ((server.deletedAt !== undefined && server.deletedAt !== null) ||
      (server.archivedAt !== undefined && server.archivedAt !== null) || server.isActive === false) {
    model.updateFromData(server);
    model.clearChanges();
    model.markAsSynced();
    return model;
  }
  const local = model.getChanges();
  for (const tx of pending) {
    if (tx.modelId !== model.id || tx.modelName !== model.getModelName() || tx.type !== 'update') continue;
    for (const [field, value] of Object.entries(tx.data ?? {})) {
      const relative = typeof value === 'object' && value !== null && ('$text' in value || '$increment' in value);
      local[field] = relative ? Reflect.get(model, field) : value;
    }
  }
  if (Object.keys(local).length > 0) {
    const merged = { ...server, ...local, ...projection };
    if (server.updatedAt || model.updatedAt) {
      merged.updatedAt = new Date(Math.max(toEpochMs(model.updatedAt), toEpochMs(server.updatedAt)));
    }
    model.updateFromData(merged);
  } else {
    model.updateFromData({ ...server, ...projection });
    model.clearChanges();
    model.markAsSynced();
  }
  return model;
}
