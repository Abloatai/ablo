import { retryOperationContention } from '../operations/contention.js';
import { OperationField, type OperationTarget, type OperationOpenOptions, type OperationTransport } from '../operations/resource.js';
import { textDomain } from './domain.js';
import type { TextHistory, TextOperation } from './contract.js';

export type TextTarget = OperationTarget;
export type TextOpenOptions = OperationOpenOptions<string, TextOperation>;
export type TextResourceTransport = OperationTransport<string, TextOperation>;
export interface TextFieldParams<Field extends string = string> extends TextOpenOptions {
  readonly id: string;
  readonly field: Field;
}
export interface TextResource { open(target: TextTarget, options?: TextOpenOptions): Promise<TextField> }

export class TextField extends OperationField<string, TextOperation> {
  constructor(target: TextTarget, transport: TextResourceTransport, history: TextHistory, options: TextOpenOptions) {
    super(textDomain, target, transport, history, options);
  }
}

export function createTextResource(transport: TextResourceTransport): TextResource {
  return {
    async open(target, options = {}) {
      const field = new TextField({ ...target }, transport, await retryOperationContention(() => transport.read(target)), options);
      try { await options.persist?.(field.exportState()); return field; }
      catch (error) { field.dispose(); throw error; }
    },
  };
}
