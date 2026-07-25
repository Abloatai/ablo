/**
 * The shared reconcile loop behind `ablo.<model>.update(id, current => next)`.
 *
 * This is the one place the "complexity lives with us" guarantee is enforced, so
 * it is tested directly against an injectable transport (no network): the loop
 * must read-fresh → compute → compare-and-swap, retry on every reconcilable
 * conflict, opt out cleanly, and surface a single `AbloContentionError` once its
 * budget is spent — never a silent clobber.
 */

import {
  reconcileFunctionalUpdate,
  isReconcilableConflict,
  type ReconcileTransport,
} from '@ablo/transaction/resources/functionalUpdate';
import {
  AbloContentionError,
  AbloStaleContextError,
  AbloClaimedError,
  AbloNotFoundError,
  AbloValidationError,
} from '@ablo/transaction/errors';

interface Row { content: string }

/**
 * An in-memory row with optimistic-concurrency semantics: a write only lands if
 * its `readAt` matches the row's current watermark, otherwise it throws
 * `stale_context` — exactly what the server does. `bump()` simulates a
 * concurrent writer moving the row out from under an in-flight update.
 */
function makeCasTransport(initial: string): {
  transport: ReconcileTransport<Row, { stamp: number }>;
  bump: (content: string) => void;
  reads: number;
  current: () => Row;
} {
  let stamp = 1;
  let row: Row = { content: initial };
  const state = { reads: 0 };
  const transport: ReconcileTransport<Row, { stamp: number }> = {
    model: 'documents',
    id: 'doc_1',
    readFresh: async () => {
      state.reads += 1;
      return { data: { ...row }, stamp };
    },
    writeNext: async (patch, readAt) => {
      if (readAt !== stamp) {
        throw new AbloStaleContextError('readAt is stale', {
          code: 'stale_context',
          readAt,
        });
      }
      row = { ...row, ...patch };
      stamp += 1;
      return { stamp };
    },
  };
  return {
    transport,
    bump: (content: string) => {
      row = { content };
      stamp += 1;
    },
    get reads() {
      return state.reads;
    },
    current: () => row,
  };
}

describe('reconcileFunctionalUpdate', () => {
  it('lands in one attempt when the row is uncontended', async () => {
    const t = makeCasTransport('hello');
    const result = await reconcileFunctionalUpdate<Row, { stamp: number }>(
      (current) => ({ content: `${current.content} world` }),
      undefined,
      t.transport,
    );
    expect(result).toEqual({ stamp: 2 });
    expect(t.current().content).toBe('hello world');
    expect(t.reads).toBe(1);
  });

  it('re-reads and recomputes from fresh state after a concurrent write (no clobber)', async () => {
    const t = makeCasTransport('a');
    let calls = 0;
    const result = await reconcileFunctionalUpdate<Row, { stamp: number }>(
      (current) => {
        calls += 1;
        // A concurrent writer lands between our first read and our first write.
        if (calls === 1) t.bump('b');
        return { content: `${current.content}+mine` };
      },
      { retries: 4 },
      t.transport,
    );
    expect(result).toBeDefined();
    // The second attempt read the concurrent 'b', so its contribution builds on
    // it rather than overwriting it — the whole point of the loop.
    expect(t.current().content).toBe('b+mine');
    expect(calls).toBe(2);
  });

  it('throws AbloContentionError once the reconcile budget is exhausted', async () => {
    const t = makeCasTransport('x');
    // A writer that ALWAYS moves the row before our write → every CAS is stale.
    const transport: ReconcileTransport<Row, { stamp: number }> = {
      ...t.transport,
      writeNext: async () => {
        throw new AbloStaleContextError('always stale', { code: 'stale_context' });
      },
    };
    await expect(
      reconcileFunctionalUpdate<Row, { stamp: number }>(
        (current) => ({ content: current.content }),
        { retries: 2 },
        transport,
      ),
    ).rejects.toMatchObject({
      type: 'AbloContentionError',
      code: 'contention_exhausted',
      attempts: 3,
    });
  });

  it('carries the last conflict as the cause of AbloContentionError', async () => {
    const t = makeCasTransport('x');
    const transport: ReconcileTransport<Row, { stamp: number }> = {
      ...t.transport,
      writeNext: async () => {
        throw new AbloClaimedError('held', { code: 'claim_queued' });
      },
    };
    const err = await reconcileFunctionalUpdate<Row, { stamp: number }>(
      (c) => ({ content: c.content }),
      { retries: 1 },
      transport,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AbloContentionError);
    expect((err as AbloContentionError).cause).toBeInstanceOf(AbloClaimedError);
  });

  it('makes no write when the updater opts out (returns null)', async () => {
    const t = makeCasTransport('unchanged');
    const result = await reconcileFunctionalUpdate<Row, { stamp: number }>(
      () => null,
      undefined,
      t.transport,
    );
    expect(result).toBeUndefined();
    expect(t.current().content).toBe('unchanged');
  });

  it('throws AbloNotFoundError when the row does not exist', async () => {
    const transport: ReconcileTransport<Row, { stamp: number }> = {
      model: 'documents',
      id: 'missing',
      readFresh: async () => ({ data: undefined, stamp: 0 }),
      writeNext: async () => ({ stamp: 1 }),
    };
    await expect(
      reconcileFunctionalUpdate<Row, { stamp: number }>((c) => c, undefined, transport),
    ).rejects.toBeInstanceOf(AbloNotFoundError);
  });

  it('propagates a non-conflict error without retrying', async () => {
    let attempts = 0;
    const transport: ReconcileTransport<Row, { stamp: number }> = {
      model: 'documents',
      id: 'doc_1',
      readFresh: async () => {
        attempts += 1;
        return { data: { content: 'x' }, stamp: 1 };
      },
      writeNext: async () => {
        throw new AbloValidationError('bad field', { code: 'not_null_violation' });
      },
    };
    await expect(
      reconcileFunctionalUpdate<Row, { stamp: number }>((c) => c, { retries: 5 }, transport),
    ).rejects.toBeInstanceOf(AbloValidationError);
    expect(attempts).toBe(1); // no reconcile rounds for a genuine failure
  });

  it('aborts before writing when the signal is already aborted', async () => {
    const t = makeCasTransport('x');
    const controller = new AbortController();
    controller.abort();
    await expect(
      reconcileFunctionalUpdate<Row, { stamp: number }>(
        (c) => c,
        { signal: controller.signal },
        t.transport,
      ),
    ).rejects.toMatchObject({ code: 'update_aborted' });
  });
});

describe('isReconcilableConflict', () => {
  it('treats stale_context and claim queued/lost as reconcilable', () => {
    expect(isReconcilableConflict(new AbloStaleContextError('s', { code: 'stale_context' }))).toBe(true);
    expect(isReconcilableConflict(new AbloClaimedError('q', { code: 'claim_queued' }))).toBe(true);
    expect(isReconcilableConflict(new AbloClaimedError('l', { code: 'claim_lost' }))).toBe(true);
  });

  it('treats a hard claim_conflict and generic errors as terminal', () => {
    expect(isReconcilableConflict(new AbloClaimedError('c', { code: 'claim_conflict' }))).toBe(false);
    expect(isReconcilableConflict(new Error('boom'))).toBe(false);
  });
});
