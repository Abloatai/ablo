/**
 * The default {@link MutationExecutor}. It sends each change as a `commit`
 * frame over the sync engine's own WebSocket, resolving that socket lazily at
 * commit time because it does not exist yet when the executor is created. A
 * client wires this up automatically unless you supply your own executor.
 */

import type { ReadDependency, TrackDependency } from '@ablo/transaction/coordination/schema';
import type {
  MutationExecutor,
  MutationOperation,
  MutationOptions,
} from '../interfaces/index.js';
import type { CommitAck } from '../sync/commitFrames.js';
import { AbloError, AbloConnectionError } from '@ablo/transaction/errors';

// ── Default mutation executor (wire: `commit` frame over WebSocket) ──────

/**
 * Creates the default mutation executor, which sends each change as a `commit`
 * frame over the sync engine's own WebSocket. The engine owns its socket, so
 * you pass a URL and credentials rather than transport callbacks.
 *
 * The factory takes a `getWs` accessor instead of a socket directly because the
 * socket is created later during client startup and does not exist yet when
 * this executor is constructed. The accessor is called at commit time to reach
 * the ready socket.
 *
 * When set, `options.idempotencyKey` is sent as the wire-level `clientTxId`, so
 * retrying a call with the same key is safe. MutationQueue always supplies
 * this key before its first attempt and owns reuse across retries. The fallback
 * generation below exists only for direct, one-shot executor consumers.
 */
	export function createDefaultMutationExecutor(
	  getWs: () => {
	    sendCommit?: (
	      operations: readonly MutationOperation[],
	      clientTxId: string,
	      timeoutMs?: number,
	      reads?: readonly ReadDependency[] | null,
	      track?: readonly TrackDependency[] | null,
	    ) => Promise<CommitAck>;
	  } | null,
	): MutationExecutor {
	  async function commit(
	    operations: MutationOperation[],
	    options?: MutationOptions,
	  ) {
    const ws = getWs();
    if (!ws?.sendCommit) {
      throw new AbloConnectionError(
        'SyncWebSocket not ready for commit. The engine must finish bootstrap ' +
          'before mutations can be sent.',
        { code: 'ws_not_ready' },
      );
    }
	    const clientTxId =
	      options?.idempotencyKey ??
	      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
	        ? crypto.randomUUID()
	        : `tx_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
	    try {
	      return await ws.sendCommit(
	        operations,
	        clientTxId,
	        undefined, // use sendCommit's built-in 15s default; no per-call override
	        options?.reads,
	        options?.track,
	      );
    } catch (err) {
      // Wrap transport-level failures as connection errors so the transaction
      // queue's retry classifier treats them as transient and retries them.
      if (err instanceof AbloError) throw err;
      if (err instanceof Error) {
        if (/not connected|timed out|connection|ECONN/i.test(err.message)) {
          const wrapped = new AbloConnectionError(err.message, { cause: err });
          // Preserve any `diagnostics` snapshot the underlying SyncWebSocket
          // attached to the rejection. Without this, the wrapped error
          // bottoms out at "AbloConnectionError: not connected" with no
          // attribution to which close code / heartbeat trip / session
          // error caused it. See SyncWebSocket.notConnectedError().
          if (
            err &&
            typeof err === 'object' &&
            'diagnostics' in err &&
            (err as { diagnostics?: unknown }).diagnostics
          ) {
            Reflect.set(wrapped, 'diagnostics', err.diagnostics);
          }
          throw wrapped;
        }
      }
      throw err;
    }
  }

  return {
    commit,
    executeCreate: (model, id, input, _txId, options) =>
      commit([{ type: 'CREATE', model: model.toLowerCase(), id, input }], options).then(() => {}),
    executeUpdate: (model, id, data, _txId, options) =>
      commit([{ type: 'UPDATE', model: model.toLowerCase(), id, input: data }], options),
    executeDelete: (model, id, _txId, options) =>
      commit([{ type: 'DELETE', model: model.toLowerCase(), id }], options).then(() => {}),
    executeArchive: (model, id, _txId, options) =>
      commit([{ type: 'ARCHIVE', model: model.toLowerCase(), id }], options).then(() => {}),
    executeUnarchive: (model, id, _txId, options) =>
      commit([{ type: 'UNARCHIVE', model: model.toLowerCase(), id }], options).then(() => {}),
  };
}
