/**
 * json.ts — key-order-insensitive comparison helpers for JSON-shaped values.
 *
 * Why this exists as a first-class, exported util:
 *
 * A `field.json()` value may be backed by a Postgres `jsonb` column, and **jsonb
 * does not preserve object key order** (it reorders keys by length, then
 * bytewise, and drops insignificant whitespace — see
 * https://www.postgresql.org/docs/current/datatype-json.html). So a document an
 * app wrote as `{type,text}` streams back in a delta as `{text,type}`: the same
 * value, a different serialization.
 *
 * That bites any app that reconciles an Ablo row against an *external* state
 * container it doesn't control — a rich-text editor (Tiptap/ProseMirror/Slate),
 * a `useState`, a form buffer. The natural guard, `JSON.stringify(remote) ===
 * JSON.stringify(local)`, is silently wrong because the two sides serialize keys
 * in different orders, so it never matches — and the app re-applies the remote
 * value on every render, clobbering in-flight edits and fighting the cursor.
 *
 * The fix is to compare order-insensitively. `deepEqual` does structural
 * equality directly; `stableStringify` produces a canonical string (recursively
 * sorted keys) for when you need a stable cache key / dependency value. The SDK
 * already uses `deepEqual` internally for store-level echo detection; this
 * module makes the same guarantee available to app authors so they don't each
 * reinvent it.
 *
 * (If you need byte-exact key order preserved end-to-end, store the field in a
 * `text` column instead of `jsonb` — Ablo's adaptive codec serializes verbatim
 * there, matching Postgres's `json` type behavior.)
 */

import { AbloValidationError } from '../errors.js';
import type { JsonValue } from '../types/streams.js';

/**
 * Takes an immutable, plain snapshot at a JSON persistence/wire boundary.
 *
 * Traversal intentionally creates fresh objects and arrays instead of relying
 * on a framework-specific unwrapping API. That makes Proxy-wrapped plain data
 * (including MobX observables) safe for IndexedDB's structured-clone algorithm
 * while keeping the settlement core independent of any reactive framework.
 *
 * The accepted contract is deliberately narrower than `JSON.stringify`:
 * values that JSON would silently corrupt (`NaN` to `null`, `Map` to `{}`) or
 * cannot encode are rejected with a stable, path-aware validation error.
 * Valid dates retain normal JSON semantics and become ISO strings. Undefined
 * object properties are omitted for compatibility with optional object keys;
 * root/array `undefined` and sparse arrays are rejected rather than becoming
 * an ambiguous `null`.
 */
export function snapshotJsonValue(value: unknown, path = '$'): JsonValue {
  try {
    return snapshotJsonNode(value, path, new WeakMap<object, string>());
  } catch (error) {
    if (error instanceof AbloValidationError) throw error;
    throw invalidJsonValue(path, 'could not be read safely', value, error);
  }
}

function snapshotJsonNode(
  value: unknown,
  path: string,
  active: WeakMap<object, string>,
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidJsonValue(path, 'must be a finite number', value);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (value === undefined) {
    throw invalidJsonValue(path, 'cannot be undefined here', value);
  }
  if (typeof value === 'bigint') {
    throw invalidJsonValue(path, 'cannot be a bigint', value);
  }
  if (typeof value === 'function') {
    throw invalidJsonValue(path, 'cannot be a function', value);
  }
  if (typeof value === 'symbol') {
    throw invalidJsonValue(path, 'cannot be a symbol', value);
  }

  if (value instanceof Date) {
    const timestamp = value.getTime();
    if (!Number.isFinite(timestamp)) {
      throw invalidJsonValue(path, 'cannot be an invalid Date', value);
    }
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const firstPath = active.get(value);
    if (firstPath !== undefined) {
      throw invalidJsonValue(path, `forms a cycle back to ${firstPath}`, value);
    }
    active.set(value, path);
    try {
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const itemPath = `${path}[${index}]`;
        if (!(index in value)) {
          throw invalidJsonValue(itemPath, 'cannot be a sparse array hole', undefined);
        }
        output.push(snapshotJsonNode(value[index], itemPath, active));
      }
      return Object.freeze(output);
    } finally {
      active.delete(value);
    }
  }

  const object = value as object;
  const firstPath = active.get(object);
  if (firstPath !== undefined) {
    throw invalidJsonValue(path, `forms a cycle back to ${firstPath}`, value);
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(object) as object | null;
  } catch (cause) {
    throw invalidJsonValue(path, 'has an unreadable prototype', value, cause);
  }
  if (prototype !== null) {
    const constructorDescriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const constructor = constructorDescriptor?.value;
    if (typeof constructor !== 'function' || constructor.name !== 'Object') {
      throw invalidJsonValue(path, 'must be a plain object', value);
    }
  }

  active.set(object, path);
  try {
    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(object);
    } catch (cause) {
      throw invalidJsonValue(path, 'has unreadable keys', value, cause);
    }

    for (const key of keys) {
      if (typeof key !== 'symbol') continue;
      let enumerable = false;
      try {
        enumerable = Object.getOwnPropertyDescriptor(object, key)?.enumerable === true;
      } catch (cause) {
        throw invalidJsonValue(path, 'has an unreadable symbol property', value, cause);
      }
      if (enumerable) {
        throw invalidJsonValue(path, 'cannot contain enumerable symbol keys', value);
      }
    }

    const output: Record<string, JsonValue> = {};
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(object, key);
      } catch (cause) {
        throw invalidJsonValue(jsonPath(path, key), 'has an unreadable property', value, cause);
      }
      if (!descriptor?.enumerable) continue;

      let child: unknown;
      try {
        child = Reflect.get(object, key);
      } catch (cause) {
        throw invalidJsonValue(jsonPath(path, key), 'could not be read', value, cause);
      }
      // Matches JSON object semantics for optional fields without allowing
      // undefined to become null inside arrays.
      if (child === undefined) continue;

      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value: snapshotJsonNode(child, jsonPath(path, key), active),
        writable: true,
      });
    }
    return Object.freeze(output);
  } finally {
    active.delete(object);
  }
}

function jsonPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function invalidJsonValue(
  path: string,
  reason: string,
  value: unknown,
  cause?: unknown,
): AbloValidationError {
  const valueType = jsonValueType(value);
  return new AbloValidationError(`Write payload ${path} ${reason}.`, {
    code: 'write_payload_invalid',
    param: path,
    details: { path, reason, valueType },
    ...(cause !== undefined ? { cause } : {}),
  });
}

function jsonValueType(value: unknown): string {
  if (value === null) return 'null';
  try {
    if (Array.isArray(value)) return 'array';
    if (value instanceof Date) return 'Date';
    if (typeof value === 'object') {
      const name = Reflect.get(value, 'constructor')?.name;
      return typeof name === 'string' ? name : 'object';
    }
  } catch {
    return typeof value;
  }
  return typeof value;
}

/** Structural equality for JSON-shaped values (scalars, arrays, plain objects); key order is ignored. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const av = a as unknown[];
    const bv = b as unknown[];
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (!deepEqual(av[i], bv[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Canonical JSON serialization: recursively sorts object keys so two values that
 * differ only in key order (e.g. a jsonb round-trip) produce the same string.
 * Use this when you need a comparable/cacheable string rather than a boolean —
 * e.g. an echo guard or a `useEffect`/`useMemo` dependency.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep(source[key]);
        return acc;
      }, {});
  }
  return value;
}
