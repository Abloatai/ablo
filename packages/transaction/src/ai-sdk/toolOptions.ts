import type { Tool } from 'ai';

/**
 * AI SDK-native presentation and execution policy shared by Ablo model tools.
 * Ablo owns the data operation; AI SDK owns how the tool is presented,
 * validated, approved, and returned to the model.
 */
export type ModelToolOptions<TInput, TResult> = Partial<
  Pick<
    Tool<TInput, TResult>,
    | 'title'
    | 'inputExamples'
    | 'needsApproval'
    | 'strict'
    | 'outputSchema'
    | 'toModelOutput'
  >
>;
