/**
 * The default `MutationExecutor` — sends `{ type: 'commit', ... }` frames over
 * the engine's own WebSocket, resolved lazily at commit time (the WS doesn't
 * exist when the executor is constructed).
 *
 * Extracted from `Ablo.ts`; the factory wires it up with a `getWs` closure
 * over the store holder unless the caller supplies its own executor.
 */

import type { StaleNotification, ReadDependency } from '../coordination/schema.js';
import type {
  MutationExecutor,
  MutationOperation,
  MutationOptions,
} from '../interfaces/index.js';
import { AbloError, AbloConnectionError } from '../errors.js';

// ── Default mutation executor (wire: `commit` frame over WebSocket) ──────

/**
 * Default mutation executor: sends `{ type: 'commit', payload: ... }` over
 * the sync engine's own WebSocket.
 *
 * Transport ownership follows the Zero / Liveblocks pattern — the engine
 * owns its socket end-to-end and the executor is internal. Apps pass URLs
 * and auth; they do NOT inject transport callbacks. That's why this
 * factory takes a `getWs` closure instead of a full SyncWebSocket: the WS
 * doesn't exist when the executor is constructed (it's created later in
 * `Ablo` during `BaseSyncedStore` init), so we resolve it
 * lazily at commit time. Same trick Zero uses internally — see
 * `packages/zero-client/src/client/zero.ts` where `Pusher`/`Puller` are
 * constructed before the socket then wired up at connect time.
 *
	 * `options.idempotencyKey` becomes the wire-level `clientTxId` when set,
	 * matching Stripe-style retry semantics. Otherwise the SDK generates one.
	 */
	export function createDefaultMutationExecutor(
	  getWs: () => {
	    sendCommit?: (
	      operations: readonly MutationOperation[],
	      clientTxId: string,
	      timeoutMs?: number,
	      causedByTaskId?: string | null,
	      reads?: readonly ReadDependency[] | null,
	    ) => Promise<{ lastSyncId: number; notifications?: StaleNotification[] }>;
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
	        options?.causedByTaskId,
	        options?.reads,
	      );
    } catch (err) {
      // Wrap transport-level failures as connection errors so the
      // TransactionQueue's retry classifier treats them as transient
      // (matches the old HTTP path's network-error handling).
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
            (wrapped as unknown as { diagnostics: unknown }).diagnostics = (
              err as { diagnostics: unknown }
            ).diagnostics;
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
