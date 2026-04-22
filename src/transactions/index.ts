/**
 * Transaction types and exports (MVP)
 *
 * Simplified for MVP: only TransactionQueue exports
 * Individual transaction classes removed in favor of simple transaction objects
 */

export { TransactionQueue } from './TransactionQueue';

// MVP: Transaction types are now simple objects, not classes
export type TransactionType = 'create' | 'update' | 'delete';

export interface Transaction {
  id: string;
  type: TransactionType;
  modelName: string;
  modelId: string;
  data?: any;
  createdAt: number;
}
