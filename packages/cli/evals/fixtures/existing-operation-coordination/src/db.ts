export interface Task {
  readonly id: string;
  readonly ownerId: string;
  readonly status: 'pending' | 'complete';
  readonly result?: string;
}

let task: Task = { id: 'task-1', ownerId: 'owner-1', status: 'pending' };

export const db = {
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  },
  tasks: {
    async get(id: string): Promise<Task | undefined> {
      return id === task.id ? task : undefined;
    },
    async complete(id: string, result: string): Promise<Task> {
      task = { ...task, id, status: 'complete', result };
      return task;
    },
  },
};
