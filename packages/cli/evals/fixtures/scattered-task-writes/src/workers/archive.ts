import { db } from '../db';

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    return operation();
  }
}

export async function archiveTask(recordId: string): Promise<void> {
  await withRetry(() => db.records.update(recordId, { status: 'archived' }));
}
