import { isObservableObject } from 'mobx';
import { Model } from '../local/Model.js';
import { getModelClientMeta } from '../local/client/createModelOperations.js';

function isRecord(value: object): boolean {
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

/** Read and detach selected data while the enclosing reaction tracks its fields. */
export function snapshotValue<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();
  function visit(input: unknown): unknown {
    if (input === null || typeof input !== 'object') return input;
    if (seen.has(input)) return seen.get(input);
    // A selected model namespace is an API handle, not row data. Preserve its
    // identity so it can still be passed to presence and other core operations.
    if (getModelClientMeta(input)) return input;
    if (input instanceof Date) {
      const date = new Date(input.getTime());
      seen.set(input, date);
      return Object.freeze(date);
    }
    if (Array.isArray(input)) {
      const array: unknown[] = new Array(input.length);
      seen.set(input, array);
      input.forEach((item, index) => { array[index] = visit(item); });
      return Object.freeze(array);
    }
    const source: object = input instanceof Model ? input.toReactiveSnapshot<Record<string, unknown>>() : input;
    if (!isRecord(source)) return input;
    const result: Record<PropertyKey, unknown> = Object.getPrototypeOf(source) === null ? Object.create(null) as Record<PropertyKey, unknown> : {};
    seen.set(input, result);
    // MobX's own symbols describe its administration, not selected application data.
    const keys = isObservableObject(source) ? Object.keys(source) : Reflect.ownKeys(source);
    for (const key of keys) {
      Object.defineProperty(result, key, {
        value: visit(Reflect.get(source, key)),
        enumerable: Object.prototype.propertyIsEnumerable.call(source, key),
      });
    }
    return Object.freeze(result);
  }
  return visit(value) as T;
}

/** Compare data snapshots, including non-enumerable schema-derived fields. */
export function equalSnapshots(a: unknown, b: unknown): boolean {
  const seen = new WeakMap<object, object>();
  function equal(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
    if (left instanceof Date || right instanceof Date) {
      return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
    }
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (!Array.isArray(left) && (!isRecord(left) || !isRecord(right))) return false;
    if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
    if (seen.has(left)) return seen.get(left) === right;
    seen.set(left, right);
    const keys = Reflect.ownKeys(left);
    if (keys.length !== Reflect.ownKeys(right).length) return false;
    return keys.every(key => Object.prototype.hasOwnProperty.call(right, key)
      && Object.prototype.propertyIsEnumerable.call(left, key) === Object.prototype.propertyIsEnumerable.call(right, key)
      && equal(Reflect.get(left, key), Reflect.get(right, key)));
  }
  return equal(a, b);
}
