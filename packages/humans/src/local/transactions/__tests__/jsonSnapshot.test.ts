import { isObservable, observable } from 'mobx';
import { AbloValidationError } from '@abloatai/transaction/errors';
import { snapshotJsonValue } from '@abloatai/transaction/utils/json';

describe('snapshotJsonValue', () => {
  it('turns nested observable JSON into a frozen plain snapshot', () => {
    const source = observable({
      style: { opacity: 0.5 },
      points: [{ x: 10, y: 20 }],
      when: new Date('2026-07-18T10:00:00.000Z'),
      optional: undefined,
    });

    const snapshot = snapshotJsonValue(source, '$.payload');

    expect(snapshot).toEqual({
      style: { opacity: 0.5 },
      points: [{ x: 10, y: 20 }],
      when: '2026-07-18T10:00:00.000Z',
    });
    expect(isObservable(snapshot)).toBe(false);
    expect(isObservable((snapshot as { style: unknown }).style)).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen((snapshot as { points: readonly unknown[] }).points)).toBe(true);
    expect(() => structuredClone(snapshot)).not.toThrow();
  });

  it.each([
    ['function', { bad: () => undefined }, '$.payload.bad'],
    ['symbol', { bad: Symbol('bad') }, '$.payload.bad'],
    ['bigint', { bad: 1n }, '$.payload.bad'],
    ['NaN', { bad: Number.NaN }, '$.payload.bad'],
    ['infinity', { bad: Number.POSITIVE_INFINITY }, '$.payload.bad'],
    ['Map', new Map([['x', 1]]), '$.payload'],
    ['Set', new Set([1]), '$.payload'],
    ['invalid Date', new Date(Number.NaN), '$.payload'],
    ['array undefined', [undefined], '$.payload[0]'],
  ])('rejects %s with a stable path-aware error', (_label, value, path) => {
    let thrown: unknown;
    try {
      snapshotJsonValue(value, '$.payload');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AbloValidationError);
    expect(thrown).toMatchObject({
      code: 'write_payload_invalid',
      param: path,
    });
  });

  it('rejects class instances, cycles, and sparse arrays', () => {
    class CustomPayload {
      value = 1;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const sparse = new Array<unknown>(2);
    sparse[1] = 'present';

    expect(() => snapshotJsonValue(new CustomPayload(), '$.payload')).toThrow(
      /must be a plain object/,
    );
    expect(() => snapshotJsonValue(cyclic, '$.payload')).toThrow(
      /forms a cycle back to \$\.payload/,
    );
    expect(() => snapshotJsonValue(sparse, '$.payload')).toThrow(
      /cannot be a sparse array hole/,
    );
  });

  it('turns an unreadable proxy into the same typed boundary error', () => {
    const revocable = Proxy.revocable({ value: 1 }, {});
    revocable.revoke();

    let thrown: unknown;
    try {
      snapshotJsonValue(revocable.proxy, '$.payload');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AbloValidationError);
    expect(thrown).toMatchObject({
      code: 'write_payload_invalid',
      param: '$.payload',
    });
  });
});
