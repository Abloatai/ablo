import { completeTask } from '../tasks/completeTask';
import type { CompleteTaskInput } from '../tasks/contract';

export const resolvers = {
  Mutation: {
    completeTask: (_parent: unknown, input: CompleteTaskInput) => completeTask(input),
  },
};
