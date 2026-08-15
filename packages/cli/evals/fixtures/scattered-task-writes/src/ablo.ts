import type { Record } from './db';

// The fixture begins with application-owned Ablo wiring already reviewed. The
// eval measures whether an installer finds and adapts every meaningful write.
export const ablo = {
  records: {
    async create({ data }: { data: Omit<Record, 'id'> }): Promise<Record> {
      return { id: 'generated', ...data };
    },
    async update({ id, data }: { id: string; data: Partial<Record> }): Promise<Record> {
      return { id, title: 'existing', status: 'open', ownerId: 'owner-1', ...data };
    },
    async delete(_input: { id: string }): Promise<void> {},
  },
};
