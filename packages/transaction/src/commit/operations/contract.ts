import { z } from 'zod';

export interface OperationSnapshot<Value> { epoch: string; version: number; value: Value }
export interface OperationEdit<Operation> { id: string; epoch: string; baseVersion: number; operation: Operation }
export interface AcceptedOperation<Operation> { id: string; epoch: string; version: number; operation: Operation }
export interface OperationHistory<Value, Operation> { base: OperationSnapshot<Value>; edits: AcceptedOperation<Operation>[] }
export interface OperationState<Value, Operation> {
  snapshot: OperationSnapshot<Value>;
  pending: { id: string; operation: Operation }[];
  inFlight: OperationEdit<Operation> | null;
  undo: Operation[];
  redo: Operation[];
}

export function operationSchemas<Value, Operation>(value: z.ZodType<Value>, operation: z.ZodType<Operation>) {
  const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const epoch = z.string().min(1).max(255);
  const id = z.string().min(1).max(255);
  const snapshot = z.strictObject({ epoch, version, value });
  const edit = z.strictObject({ id, epoch, baseVersion: version, operation });
  const accepted = edit.omit({ baseVersion: true }).extend({ version });
  const history = z.strictObject({ base: snapshot, edits: z.array(accepted) });
  const state = z.strictObject({
    snapshot,
    pending: z.array(z.strictObject({ id, operation })).default([]),
    inFlight: edit.nullable().default(null),
    undo: z.array(operation).default([]), redo: z.array(operation).default([]),
  });
  return { snapshot, edit, accepted, history, state };
}

export interface OperationDomain<Value, Operation> {
  readonly requiresHistory: boolean;
  readonly schemas: ReturnType<typeof operationSchemas<Value, Operation>>;
  apply(value: Value, operation: Operation): Value;
  invert(value: Value, operation: Operation): Operation;
  transform(operation: Operation, concurrent: Operation, side: 'left' | 'right'): Operation;
}

/** A small pointer, not historical text: payloads are read through authorized history. */
export const acceptedOperationReferenceSchema = z.strictObject({
  id: z.string().min(1).max(255),
  kind: z.enum(['text', 'counter']),
  field: z.string().min(1),
  epoch: z.string().min(1).max(255),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type AcceptedOperationReference = z.infer<typeof acceptedOperationReferenceSchema>;
