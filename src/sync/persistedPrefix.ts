/**
 * Returns the highest sync id in the durable prefix of an ordered delta frame.
 *
 * A frame may span several IndexedDB stores, each committed in its own
 * transaction. Those transactions can succeed and fail independently. The
 * resume cursor may advance only through the first failed input: taking the
 * maximum id from any successful store would skip an earlier failed delta on
 * every later catch-up.
 */
export function highestPersistedPrefixSyncId(
  deltas: readonly { readonly syncId?: number | string }[],
  persistedIndexes: ReadonlySet<number>,
): number {
  let through = 0;

  for (let index = 0; index < deltas.length; index += 1) {
    if (!persistedIndexes.has(index)) break;

    const raw = deltas[index]?.syncId;
    const syncId = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof syncId === 'number' && Number.isFinite(syncId) && syncId > through) {
      through = syncId;
    }
  }

  return through;
}
