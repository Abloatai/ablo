/**
 * Internal compatibility entrypoint for the schema-powered realtime client.
 *
 * Use this build for applications that need typed model proxies,
 * subscriptions, presence, offline queueing, and a long-lived WebSocket.
 */

export { Ablo, computeFKDepthPriority } from '../client/Ablo.js';
export type {
  AbloOptions,
  InternalAbloOptions,
  ModelCountOptions,
  ModelListOptions,
  ModelListScope,
  ModelLoadOptions,
  ModelOperations,
} from '../client/Ablo.js';

import { Ablo } from '../client/Ablo.js';

export default Ablo;
