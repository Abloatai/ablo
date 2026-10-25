import { foldOperationHistory, reconcileOperation } from '../operations/history.js';
import { textDomain } from './domain.js';
import type { TextHistory, TextEdit } from './contract.js';

export const foldTextHistory = (history: TextHistory) => foldOperationHistory(textDomain, history);
export const reconcileTextEdit = (history: TextHistory, edit: TextEdit, value: string) =>
  reconcileOperation(textDomain, history, edit, value);
