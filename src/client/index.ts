/**
 * @ablo/sync-engine/client — Consumer API
 *
 * The one-liner entry point for external consumers.
 * Define your schema, call createSyncEngine(), done.
 *
 * ```ts
 * import { createSyncEngine } from '@ablo/sync-engine/client';
 * import { schema } from './schema';
 *
 * const sync = createSyncEngine({ url: 'wss://api.example.com', schema });
 *
 * const tasks = sync.tasks.findMany({ where: { status: 'todo' } });
 * await sync.tasks.create({ title: 'New task' });
 * ```
 */

export {
  createSyncEngine,
  type SyncEngine,
  type SyncEngineOptions,
  type ModelOperations,
} from './createSyncEngine';
