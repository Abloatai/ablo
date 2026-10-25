import { retryOperationContention } from '../operations/contention.js';
import { OperationField, type OperationTarget, type OperationOpenOptions, type OperationTransport } from '../operations/resource.js';
import { z } from 'zod';
import { AbloValidationError } from '../../errors.js';
import { operationSchemas } from '../operations/contract.js';
import { foldOperationHistory, reconcileOperation } from '../operations/history.js';
import { OperationSession } from '../operations/session.js';

export const counterValueSchema = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
export const counterOperationSchema = counterValueSchema;
const schemas = operationSchemas(counterValueSchema, counterOperationSchema);
export const counterHistorySchema = schemas.history;
export const counterEditSchema = schemas.edit;
export const counterEditValueSchema = z.strictObject({ $increment: counterEditSchema });
export type CounterHistory = z.infer<typeof counterHistorySchema>;
export type CounterEdit = z.infer<typeof counterEditSchema>;
export type CounterSessionState = z.infer<typeof schemas.state>;

export function applyCounterOperation(value: number, amount: number): number {
  const result = counterValueSchema.parse(value) + counterOperationSchema.parse(amount);
  if (!Number.isSafeInteger(result)) {
    throw new AbloValidationError('Counter result exceeds the safe integer range.', { code: 'invalid_input' });
  }
  return result;
}

export const counterDomain = {
  requiresHistory: false,
  schemas,
  apply: applyCounterOperation,
  invert(value: number, amount: number) { applyCounterOperation(value, amount); return -amount; },
  transform(amount: number, _concurrent: number, _side: 'left' | 'right') { return counterOperationSchema.parse(amount); },
};
export const foldCounterHistory = (history: CounterHistory) => foldOperationHistory(counterDomain, history);
export const reconcileCounterEdit = (history: CounterHistory, edit: CounterEdit, value: number) =>
  reconcileOperation(counterDomain, history, edit, value);
export class CounterSession extends OperationSession<number, number> {
  constructor(input: unknown) { super(counterDomain, input); }
}

export interface CounterFieldParams<Field extends string = string> extends OperationOpenOptions<number, number> {
  readonly id: string;
  readonly field: Field;
}
export class CounterField extends OperationField<number, number> {
  constructor(target: OperationTarget, transport: OperationTransport<number, number>, history: CounterHistory, options: OperationOpenOptions<number, number>) {
    super(counterDomain, target, transport, history, options);
  }
  increment(amount: number): Promise<void> { return this.edit(amount); }
}
export function createCounterResource(transport: OperationTransport<number, number>) {
  return {
    async open(target: OperationTarget, options: OperationOpenOptions<number, number> = {}) {
      const field = new CounterField({ ...target }, transport, await retryOperationContention(() => transport.read(target)), options);
      try { await options.persist?.(field.exportState()); return field; }
      catch (error) { field.dispose(); throw error; }
    },
  };
}
