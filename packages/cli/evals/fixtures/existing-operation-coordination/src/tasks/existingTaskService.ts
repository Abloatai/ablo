import { assertCanComplete } from '../auth';
import { db } from '../db';
import type { CompleteTaskInput, CompleteTaskResult } from './contract';

export const existingTaskService = {
  get: (id: string) => db.tasks.get(id),

  async commitPrepared(
    input: CompleteTaskInput,
    preparedResult: string,
  ): Promise<CompleteTaskResult> {
    return db.transaction(async () => {
      assertCanComplete(input.actorId, input.ownerId);
      const current = await db.tasks.get(input.id);
      if (!current) throw new Error('task_not_found');
      if (current.status === 'complete') {
        return { outcome: 'completed', task: current };
      }
      const task = await db.tasks.complete(input.id, preparedResult);
      return { outcome: 'completed', task };
    });
  },
};
