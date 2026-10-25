import { operationSchemas } from '../operations/contract.js';
import { textValueSchema, textOperationSchema } from './contract.js';
import { applyTextOperation, invertTextOperation, transformTextOperation } from './operations.js';

export const textDomain = {
  requiresHistory: true,
  schemas: operationSchemas(textValueSchema, textOperationSchema),
  apply: applyTextOperation, invert: invertTextOperation, transform: transformTextOperation,
};
