export interface Record {
  readonly id: string;
  readonly title: string;
  readonly status: 'open' | 'archived';
  readonly ownerId: string;
}

export const db = {
  records: {
    async create(input: Omit<Record, 'id'>): Promise<Record> {
      return { id: 'generated', ...input };
    },
    async update(id: string, data: Partial<Record>): Promise<Record> {
      return { id, title: 'existing', status: 'open', ownerId: 'owner-1', ...data };
    },
    async delete(_id: string): Promise<void> {},
  },
};
