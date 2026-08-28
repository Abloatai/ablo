import { existingTaskService } from './existingTaskService';
import type { CompleteTaskInput, CompleteTaskResult } from './contract';

async function prepareInSandbox(input: CompleteTaskInput): Promise<string> {
  return `prepared:${input.requestedResult}`;
}

export async function completeTask(
  input: CompleteTaskInput,
): Promise<CompleteTaskResult> {
  const prepared = await prepareInSandbox(input);
  return existingTaskService.commitPrepared(input, prepared);
}
