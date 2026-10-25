/** Versioned plain-text operations; persistence and transport remain commit-owned. */
export {
  TEXT_HISTORY_TABLE,
  textValueSchema,
  textOperationSchema,
  textSnapshotSchema,
  textEditSchema,
  textEditValueSchema,
  isTextEditValue,
  acceptedTextEditSchema,
  textHistorySchema,
  type TextOperation,
  type TextSnapshot,
  type TextEdit,
  type AcceptedTextEdit,
  type TextHistory,
  textSessionStateSchema,
  type TextSessionState,
} from './contract.js';
export { applyTextOperation, invertTextOperation, transformTextOperation } from './operations.js';
export { foldTextHistory, reconcileTextEdit } from './history.js';
export { TextSession } from './session.js';
export { createTextResource, TextField, type TextResource, type TextTarget, type TextOpenOptions, type TextFieldParams } from './resource.js';

export { textDomain } from './domain.js';
