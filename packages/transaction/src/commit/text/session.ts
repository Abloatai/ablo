import { OperationSession } from '../operations/session.js';
import { textDomain } from './domain.js';
import type { TextOperation } from './contract.js';

export class TextSession extends OperationSession<string, TextOperation> {
  constructor(input: unknown) { super(textDomain, input); }
}
