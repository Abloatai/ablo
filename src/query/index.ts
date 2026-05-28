/**
 * Query module barrel — re-exports the public surface for convenience.
 * See types.ts and client.ts for the actual definitions.
 */

export type { Query, QueryBatch, QueryBatchResult } from './types.js';
export { postQuery, type PostQueryOptions } from './client.js';
