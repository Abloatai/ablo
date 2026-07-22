/**
 * Moved to the settlement core with the duplex transport (ADR 0016): the
 * connection state machine is plain, mobx-free plumbing an agent needs as much
 * as a browser does. This path re-exports it so existing importers stay
 * unchanged; the reactive store mirrors its transitions through
 * `ConnectionCallbacks.onStateChange` into its own observable `syncStatus`.
 */

export {
  ConnectionManager,
  type ConnectionState,
  type ConnectionEvent,
  type ConnectionCallbacks,
  type ConnectionManagerOptions,
} from '../transaction/transport/connectionManager.js';
