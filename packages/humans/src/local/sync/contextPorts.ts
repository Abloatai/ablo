/**
 * The runtime context, sliced into the ports the settlement core's transport
 * takes. The core is injected, never service-located (ADR 0016), while this
 * package resolves its shared dependencies through `getContext()` — so these
 * adapters bridge the two: each method reads the context at call time, which
 * preserves the lazy semantics of `getContext()` (a context installed after
 * construction is still picked up, and the pre-init fallback still applies).
 */

import { getContext } from '../context.js';
import type { Logger } from '@ablo/transaction/logger';
import type { SocketObservability } from '@ablo/transaction/observability';

/** The context's logger, resolved at call time. */
export const contextLogger: Logger = {
  debug: (message, ...args) => { getContext().logger.debug(message, ...args); },
  info: (message, ...args) => { getContext().logger.info(message, ...args); },
  warn: (message, ...args) => { getContext().logger.warn(message, ...args); },
  error: (message, ...args) => { getContext().logger.error(message, ...args); },
};

/** The context's observability, resolved at call time, in the transport's shape. */
export const contextSocketObservability: SocketObservability = {
  breadcrumb: (message, category, level, data) => {
    getContext().observability.breadcrumb(message, category, level, data);
  },
  captureWebSocketError: (details) => {
    getContext().observability.captureWebSocketError(details);
  },
  captureClaim: (event) => { getContext().observability.captureClaim(event); },
  captureConflict: (event) => { getContext().observability.captureConflict(event); },
};

/** The context's online-status provider, resolved at call time. */
export const contextOnlineStatus = {
  isOnline: (): boolean => getContext().onlineStatus.isOnline(),
};
