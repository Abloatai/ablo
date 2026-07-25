/**
 * Moved to the settlement core with the duplex transport (ADR 0016): the
 * inbound frame dispatch is the receiving half of the wire protocol, and the
 * handlers already worked against the minimal `WsSession` port rather than
 * the transport object. This path re-exports it so existing importers stay
 * unchanged.
 */

export {
  isRecord,
  readWsInboundFrame,
  wsFrameHandlers,
  dispatchWsFrame,
  type PendingCommit,
  type PendingClaim,
  type PendingSubscription,
  type WsInboundFrame,
  type WsSession,
  type WsFrameHandler,
} from '@abloatai/transaction/transport/wsFrameHandlers';
