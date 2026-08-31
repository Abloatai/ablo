import type { ReadDependency } from '../../coordination/schema.js';
import { AbloStaleContextError } from '../../errors.js';
import type { AbloWebSocketSession } from './sessionContract.js';

/** Watch captured reads over the client's already-open WebSocket. */
export function subscribeWebSocketReadChanges(
  session: AbloWebSocketSession,
  reads: readonly ReadDependency[],
  listener: (error: AbloStaleContextError) => void,
): () => void {
  if (reads.length === 0) return () => undefined;
  const watchedRows = new Map(
    reads
      .filter((read): read is Extract<ReadDependency, { model: string }> => 'model' in read)
      .map((read) => [`${read.model.toLowerCase()}:${read.id}`, read.readAt]),
  );
  const watchedGroups = new Map<string, number>(
    reads
      .filter((read): read is Extract<ReadDependency, { group: string }> => 'group' in read)
      .map((read) => [read.group, read.readAt]),
  );
  let stopped = false;
  let unsubscribe = (): void => undefined;
  unsubscribe = session.subscribe('delta', (delta) => {
    if (stopped) return;
    const readAt = watchedRows.get(`${delta.modelName.toLowerCase()}:${delta.modelId}`)
      ?? delta.syncGroups.reduce<number | undefined>((latest, group) => {
        const groupReadAt = watchedGroups.get(group);
        return groupReadAt === undefined
          ? latest
          : Math.max(latest ?? groupReadAt, groupReadAt);
      }, undefined);
    if (readAt === undefined || delta.id <= readAt) return;
    stopped = true;
    unsubscribe();
    listener(new AbloStaleContextError(
      `Captured context changed: ${delta.modelName}/${delta.modelId}.`,
      {
        code: 'stale_context',
        details: {
          conflicts: [{
            model: delta.modelName,
            id: delta.modelId,
            readAt,
            current: delta.id,
          }],
        },
      },
    ));
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}
