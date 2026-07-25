/**
 * Write-options threading — the one-dialect contract.
 *
 * The public params of `ablo.<model>.create/update/delete` promise the full
 * `WriteOptions` vocabulary (`idempotencyKey`, `label`, `readAt`, `onStale`).
 * These tests pin the pipeline end (MutationQueue → MutationExecutor):
 * every field a caller puts on a write must reach the wire operation —
 * `readAt`/`onStale` at the op root, `idempotencyKey`/`label` in the op's
 * `options` slot (`MutationOperation.options`). Before this contract was
 * enforced, the queue silently narrowed to `readAt`/`onStale` and the rest
 * compiled but did nothing.
 */

import {
  MutationQueue,
  type UserContext,
} from '../mutations/MutationQueue.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';
import { createTaskFixture } from '../../testing/fixtures/models.js';
import { waitFor } from '../../testing/helpers/wait.js';
import type { MutationOperation } from '../../interfaces/index.js';
import { assertWriteOptions } from '@ablo/transaction/resources/writeOptionsSchema';
import { AbloValidationError } from '@ablo/transaction/errors';

describe('MutationQueue write-options threading', () => {
  let ctx: TestContextResult;
  let queue: MutationQueue;
  const userContext: UserContext = {
    userId: 'user_1',
    organizationId: 'org_1',
  };

  beforeEach(() => {
    ctx = createTestContext();
    queue = new MutationQueue({ enablePersistence: false });
  });

  afterEach(() => {
    queue.dispose?.();
    ctx.cleanup();
  });

  const committedOperations = (): MutationOperation[] =>
    ctx.mocks.mutationExecutor
      .getCallsByMethod('commit')
      .flatMap((call) => call.operations ?? []);

  it('carries idempotencyKey and label onto the wire operation options', async () => {
    const task = createTaskFixture();

    await queue.create(task, userContext, {
      idempotencyKey: 'idem_test_1',
      label: 'nightly cleanup',
    });

    await waitFor(() => committedOperations().length > 0);
    const [op] = committedOperations();
    if (!op) throw new Error('expected a committed operation');
    expect(op.options).toEqual({
      idempotencyKey: 'idem_test_1',
      label: 'nightly cleanup',
    });
  });

  it('carries the stale guard (readAt/onStale) alongside idempotency on one op', async () => {
    const task = createTaskFixture();

    await queue.create(task, userContext, {
      idempotencyKey: 'idem_test_2',
      label: 'claimed write',
      readAt: 42,
      onStale: 'reject',
    });

    await waitFor(() => committedOperations().length > 0);
    const [op] = committedOperations();
    if (!op) throw new Error('expected a committed operation');
    expect(op.readAt).toBe(42);
    expect(op.onStale).toBe('reject');
    expect(op.options).toEqual({
      idempotencyKey: 'idem_test_2',
      label: 'claimed write',
    });
  });

  it('omits the options slot entirely when no idempotency fields are set', async () => {
    const task = createTaskFixture();

    await queue.create(task, userContext, { readAt: 7, onStale: 'notify' });

    await waitFor(() => committedOperations().length > 0);
    const [op] = committedOperations();
    if (!op) throw new Error('expected a committed operation');
    expect(op.readAt).toBe(7);
    expect(op.onStale).toBe('notify');
    expect(op.options).toBeUndefined();
  });

  it('opting out with idempotencyKey: null does not stamp an options slot', async () => {
    const task = createTaskFixture();

    await queue.create(task, userContext, { idempotencyKey: null });

    await waitFor(() => committedOperations().length > 0);
    const [op] = committedOperations();
    if (!op) throw new Error('expected a committed operation');
    expect(op.options).toBeUndefined();
  });
});

describe('writeOptionsSchema — THE runtime write-options contract', () => {
  it('accepts the full dialect', () => {
    expect(() =>
      { assertWriteOptions({
        idempotencyKey: 'idem_1',
        label: 'audit tag',
        wait: 'confirmed',
        readAt: 42,
        onStale: 'reject',
        claim: { id: 'claim_1' },
      }); },
    ).not.toThrow();
  });

  it('accepts a live lease handle in the claim slot (functions survive — validate-only)', () => {
    const lease = {
      id: 'claim_2',
      release: async () => {},
      revoke: () => {},
    };
    expect(() => { assertWriteOptions({ claim: lease }); }).not.toThrow();
    // Validation never replaces the object — the handle keeps its functions.
    expect(typeof lease.release).toBe('function');
  });

  it('rejects a misspelled onStale with a typed, param-targeted error', () => {
    try {
      assertWriteOptions({ onStale: 'rejct' }, 'task write');
      throw new Error('expected assertWriteOptions to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AbloValidationError);
      const abloErr = err as AbloValidationError;
      expect(abloErr.code).toBe('write_options_invalid');
      expect(abloErr.param).toBe('onStale');
      expect(abloErr.message).toContain('task write');
    }
  });

  it('rejects a non-integer readAt watermark', () => {
    expect(() => { assertWriteOptions({ readAt: 1.5 }); }).toThrow(
      AbloValidationError,
    );
  });

  it('rejects an empty idempotencyKey (null is the explicit opt-out)', () => {
    expect(() => { assertWriteOptions({ idempotencyKey: '' }); }).toThrow(
      AbloValidationError,
    );
    expect(() => { assertWriteOptions({ idempotencyKey: null }); }).not.toThrow();
  });

  it('treats absent options as valid (the default path stays zero-cost)', () => {
    expect(() => { assertWriteOptions(undefined); }).not.toThrow();
    expect(() => { assertWriteOptions(null); }).not.toThrow();
    expect(() => { assertWriteOptions({}); }).not.toThrow();
  });
});
