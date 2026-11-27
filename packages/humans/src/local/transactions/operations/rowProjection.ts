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

  // Fast path: no pending transactions and no local dirty edits (the
  // overwhelming majority of catch-up and live remote updates). Avoids
  // allocating intermediate `local`, `getChanges()`, `Object.keys()`, and
  // `{ ...server }` copies on every row.
  if (pending.length === 0 && !model.hasChanges) {
    model.updateFromData(projection ? { ...server, ...projection } : server);
    model.clearChanges();
    model.markAsSynced();
    return model;
  }

  const local: Record<string, unknown> = {};
  let hasLocal = false;
  if (pending.length > 0) {
    const modelId = model.id;
    const modelName = model.getModelName();
    for (const tx of pending) {
      if (tx.modelId !== modelId || tx.modelName !== modelName || tx.type !== 'update') continue;
      const txData = tx.data;
      if (!txData) continue;
      for (const [field, value] of Object.entries(txData)) {
        const relative = typeof value === 'object' && value !== null && ('$text' in value || '$increment' in value);
        local[field] = relative ? Reflect.get(model, field) : value;
        hasLocal = true;
      }
    }
  }
  // Unstaged edits happened after the already-frozen queued writes.
  if (model.hasChanges) {
    Object.assign(local, model.getChanges());
    hasLocal = true;
  }
  if (hasLocal) {
    const merged = projection ? { ...server, ...local, ...projection } : { ...server, ...local };
    if (server.updatedAt || model.updatedAt) {
      merged.updatedAt = new Date(Math.max(toEpochMs(model.updatedAt), toEpochMs(server.updatedAt)));
    }
    model.updateFromData(merged);
  } else {
    model.updateFromData(projection ? { ...server, ...projection } : server);
    model.clearChanges();
    model.markAsSynced();
  }
  return model;
}
