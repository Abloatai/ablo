import type { AbloClient } from '../client.js';
import type { SchemaRecord } from '@abloatai/transaction/schema/schema';
import type { SyncStoreContract } from './storeContract.js';

/** Access the supported local store contract for custom framework adapters,
 * demand loading, scope management and custom undo infrastructure.
 */
export function getAbloStore<S extends SchemaRecord>(client: AbloClient<S>): SyncStoreContract {
  return client._store;
}
