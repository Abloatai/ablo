import { db, type Record } from '../db';

export async function createTask(input: Omit<Record, 'id' | 'status'>): Promise<Record> {
  if (input.title.trim().length === 0) throw new Error('title_required');
  return db.records.create({ ...input, status: 'open' });
}

export async function renameTask(id: string, title: string): Promise<Record> {
  if (title.trim().length === 0) throw new Error('title_required');
  return db.records.update(id, { title });
}
