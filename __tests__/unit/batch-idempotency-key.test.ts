/**
 * Idempotency-key derivation — invariants for the
 * server's `hashOperations` helper (same algorithm the default
 * executor uses to derive its per-batch `Idempotency-Key` header).
 *
 * Invariants:
 *   - Deterministic: same operation set produces the same hash.
 *   - Order-independent: sort normalization handles any arrival order.
 *   - Separator-safe: [{model:"ab",id:"c"}] must not collide with
 *     [{model:"a",id:"bc"}].
 *   - SHA-256-backed, not a toy hash.
 *   - Pure — no DB or network calls.
 */

import { hashOperations } from '../../src/server/idempotencyCache';

describe('hashOperations', () => {
  it('is deterministic — same ops in same order produce the same hash', () => {
    const ops = [
      { type: 'CREATE', model: 'task', id: '1', input: { title: 'a' } },
      { type: 'UPDATE', model: 'task', id: '2', input: { title: 'b' } },
    ];
    expect(hashOperations(ops)).toBe(hashOperations(ops));
  });

  it('is order-independent — same set in different orders produces the same hash', () => {
    const a = [
      { type: 'CREATE', model: 'task', id: '1', input: { title: 'a' } },
      { type: 'UPDATE', model: 'task', id: '2', input: { title: 'b' } },
    ];
    const b = [
      { type: 'UPDATE', model: 'task', id: '2', input: { title: 'b' } },
      { type: 'CREATE', model: 'task', id: '1', input: { title: 'a' } },
    ];
    expect(hashOperations(a)).toBe(hashOperations(b));
  });

  it('produces different hashes for different op sets', () => {
    const a = [{ type: 'CREATE', model: 'task', id: '1', input: { title: 'a' } }];
    const b = [{ type: 'CREATE', model: 'task', id: '2', input: { title: 'a' } }];
    expect(hashOperations(a)).not.toBe(hashOperations(b));
  });

  it('distinguishes {model:"ab", id:"c"} from {model:"a", id:"bc"}', () => {
    const a = [{ type: 'CREATE', model: 'ab', id: 'c' }];
    const b = [{ type: 'CREATE', model: 'a', id: 'bc' }];
    expect(hashOperations(a)).not.toBe(hashOperations(b));
  });

  it('distinguishes different input payloads for same (model, id, type)', () => {
    const a = [{ type: 'UPDATE', model: 'task', id: '1', input: { title: 'v1' } }];
    const b = [{ type: 'UPDATE', model: 'task', id: '1', input: { title: 'v2' } }];
    expect(hashOperations(a)).not.toBe(hashOperations(b));
  });

  it('distinguishes CREATE vs UPDATE for same (model, id)', () => {
    const a = [{ type: 'CREATE', model: 'task', id: '1', input: { title: 'x' } }];
    const b = [{ type: 'UPDATE', model: 'task', id: '1', input: { title: 'x' } }];
    expect(hashOperations(a)).not.toBe(hashOperations(b));
  });

  it('produces 64-char hex output (SHA-256 hex)', () => {
    const ops = [{ type: 'CREATE', model: 'task', id: '1' }];
    const h = hashOperations(ops);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes empty set from any singleton', () => {
    expect(hashOperations([])).not.toBe(
      hashOperations([{ type: 'CREATE', model: 'task', id: '1' }]),
    );
  });
});
