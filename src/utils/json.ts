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
