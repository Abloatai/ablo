import type { Task } from '../db';

export interface CompleteTaskInput {
  readonly id: string;
  readonly actorId: string;
  readonly ownerId: string;
  readonly requestedResult: string;
}

export type CompleteTaskResult =
  | { readonly outcome: 'completed'; readonly task: Task }
  | { readonly outcome: 'skipped'; readonly task?: Task };
