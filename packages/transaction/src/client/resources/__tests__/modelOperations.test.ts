import {
  claimAttemptFailure,
  claimQueueView,
  emitClaimStatus,
  resolveClaimContentionOptions,
} from '../modelOperations.js';
import { AbloClaimedError } from '../../../errors.js';

describe('structured claim queue options', () => {
  it('resolves the structured wait policy in one place', () => {
    const signal = new AbortController().signal;
    const onStatus = jest.fn();

    expect(
      resolveClaimContentionOptions({
        contention: {
          mode: 'wait',
          maxDepth: 3,
          timeoutMs: 5_000,
          signal,
          onStatus,
        },
      }),
    ).toEqual({
      wait: true,
      maxDepth: 3,
      timeoutMs: 5_000,
      signal,
      onStatus,
    });
  });

  it('maps structured skip and preserves the boolean shorthand', () => {
    expect(
      resolveClaimContentionOptions({ contention: { mode: 'skip' } }),
    ).toEqual({ wait: false });
    expect(resolveClaimContentionOptions({ queue: false })).toEqual({ wait: false });
    expect(resolveClaimContentionOptions({})).toEqual({ wait: true });
  });

  it('keeps legacy flat limits as compatibility fallbacks', () => {
    expect(
      resolveClaimContentionOptions({
        contention: { maxDepth: 2 },
        maxQueueDepth: 9,
        waitTimeoutMs: 1_000,
      }),
    ).toEqual({
      wait: true,
      maxDepth: 2,
      timeoutMs: 1_000,
    });
  });

  it('isolates notification failures', () => {
    expect(() =>
      emitClaimStatus(
        () => {
          throw new Error('render failed');
        },
        { type: 'granted', claimId: 'cl_1', waited: false },
      ),
    ).not.toThrow();
  });

  it('separates an expected skip from an actual failed request', () => {
    const contention = new AbloClaimedError('already held', {
      code: 'claim_conflict',
    });
    const timeout = new AbloClaimedError('wait expired', {
      code: 'grant_timeout',
    });

    expect(claimAttemptFailure(false, contention)).toEqual({
      type: 'skipped',
      error: contention,
    });
    expect(claimAttemptFailure(true, contention)).toEqual({
      type: 'failed',
      error: contention,
    });
    expect(claimAttemptFailure(false, timeout)).toEqual({
      type: 'failed',
      error: timeout,
    });
  });

  it('gives the wait line named structure without dropping the list envelope', () => {
    const first = {
      object: 'claim' as const,
      id: 'cl_1',
      status: 'queued' as const,
      target: { type: 'items', id: 't_1' },
      description: 'first',
    };
    const view = claimQueueView([first]);

    expect(view).toEqual({
      object: 'list',
      data: [first],
      waiting: [first],
      size: 1,
      next: first,
    });
    expect(view.waiting).toBe(view.data);
  });
});
