/**
 * Commit subsystem.
 *
 * Start here and descend through the lifecycle contract, durable confirmation
 * records, persistence port, request normalization, and runtime observation.
 * Transport mechanisms consume this boundary; they do not own commit meaning.
 */
export * from './contract.js';
export * from './durableWrites.js';
export * from './httpRequest.js';
export * from './recordRuntime.js';
export * from './readSetContext.js';
export {
  TextSession,
  textDomain,
  TEXT_HISTORY_TABLE,
  TextField,
  createTextResource,
  type TextResource,
  type TextTarget,
  type TextOpenOptions,
  type TextFieldParams,
  textValueSchema,
  textHistorySchema,
  textEditValueSchema,
  isTextEditValue,
  foldTextHistory,
  reconcileTextEdit,
  applyTextOperation,
  type TextHistory,
  type TextEdit,
  type TextSnapshot,
  type TextOperation,
  type TextSessionState,
} from './text/index.js';
export * from './confirmation/commitEnvelope.js';
export * from './confirmation/httpCommitEnvelope.js';
export * from './confirmation/idempotencyKey.js';
export * from './confirmation/pendingWrite.js';

export {
  OperationSession, OperationField, foldOperationHistory, reconcileOperation,
  acceptedOperationReferenceSchema,
  type OperationSnapshot, type OperationEdit, type AcceptedOperation, type OperationHistory,
  type OperationState, type OperationDomain, type AcceptedOperationReference,
  type OperationTarget, type OperationOpenOptions, type OperationTransport,
} from './operations/index.js';
export {
  CounterField, CounterSession, createCounterResource, counterDomain,
  counterValueSchema, counterOperationSchema, counterHistorySchema, counterEditSchema, counterEditValueSchema,
  applyCounterOperation, foldCounterHistory, reconcileCounterEdit,
  type CounterFieldParams, type CounterHistory, type CounterEdit, type CounterSessionState,
} from './counter/index.js';
export { createModelFieldResources } from './operations/resources.js';
export { projectFieldEdits, invertAcceptedFieldEdit } from './operations/model.js';
export { rebaseOperationContext, appendContextOperation, appendIndependentOperation, prepareContextOperation, type OperationContext } from './operations/context.js';
export { retryOperationContention } from './operations/contention.js';
