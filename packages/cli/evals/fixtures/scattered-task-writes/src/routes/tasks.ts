import { assertCanEdit } from '../auth';
import { db } from '../db';

export async function deleteTaskRoute(input: {
  actorId: string;
  ownerId: string;
  recordId: string;
}): Promise<{ status: 204 }> {
  assertCanEdit(input.actorId, input.ownerId);
  await db.records.delete(input.recordId);
  return { status: 204 };
}
