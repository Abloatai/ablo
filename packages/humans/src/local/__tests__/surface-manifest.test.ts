/**
 * Drift guard for the public surface manifest (src/surface.ts).
 *
 * surface.ts proves each tuple === `keyof <Type>` at compile time via
 * `Expect<Equal<…>>`. Do not restate those contracts as local object literals
 * here: that creates a second list which has to be edited for every new verb.
 * Runtime coverage only checks the property a type assertion cannot: duplicate
 * values inside a tuple.
 */
import { describe, it, expect } from '@jest/globals';
import {
  PUBLIC_MODEL_VERBS,
  PUBLIC_LIST_OPTION_KEYS,
  PUBLIC_ABLO_OPTION_KEYS,
} from '../../surface.js';

describe('public surface manifest matches the real exported types', () => {
  it('has no duplicate names', () => {
    for (const tuple of [
      PUBLIC_MODEL_VERBS,
      PUBLIC_LIST_OPTION_KEYS,
      PUBLIC_ABLO_OPTION_KEYS,
    ]) {
      expect(new Set(tuple).size).toBe(tuple.length);
    }
  });
});
