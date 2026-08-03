/**
 * Drift guard for the public surface manifest (src/surface.ts).
 *
 * surface.ts already proves each tuple === `keyof <Type>` at COMPILE time via
 * `Expect<Equal<…>>`. This is the runtime belt: each `Record<keyof X, true>`
 * sample below is itself compile-complete (omit a key → TS error here; add a
 * phantom → TS error here), so `Object.keys(sample)` IS the real key set, and we
 * assert the exported tuple equals it. Adding/removing a verb or option without
 * updating surface.ts fails either tsc or this test.
 */
import { describe, it, expect } from '@jest/globals';
import {
  PUBLIC_MODEL_VERBS,
  PUBLIC_LIST_OPTION_KEYS,
  PUBLIC_ABLO_OPTION_KEYS,
} from '../../surface.js';
import type { ModelOperations, LocalReadOptions } from '../client/createModelProxy.js';
import type { AbloOptions } from '../../Ablo.js';

describe('public surface manifest matches the real exported types', () => {
  it('PUBLIC_MODEL_VERBS === keyof ModelOperations', () => {
    const sample: Record<keyof ModelOperations<unknown, unknown>, true> = {
      get: true,
      retrieve: true,
      list: true,
      local: true,
      create: true,
      update: true,
      delete: true,
      claim: true,
      track: true,
      join: true,
      onChange: true,
    };
    expect([...PUBLIC_MODEL_VERBS].sort()).toEqual(Object.keys(sample).sort());
  });

  it('PUBLIC_LIST_OPTION_KEYS === keyof LocalReadOptions', () => {
    const sample: Record<keyof LocalReadOptions<unknown>, true> = {
      where: true,
      filter: true,
      orderBy: true,
      limit: true,
      offset: true,
      state: true,
    };
    expect([...PUBLIC_LIST_OPTION_KEYS].sort()).toEqual(Object.keys(sample).sort());
  });

  it('PUBLIC_ABLO_OPTION_KEYS === keyof AbloOptions', () => {
    const sample: Record<keyof AbloOptions, true> = {
      schema: true,
      plugins: true,
      apiKey: true,
      projectId: true,
      branchId: true,
      authEndpoint: true,
      authTimeoutMs: true,
      allowCrossOriginAuthEndpoint: true,
      persistence: true,
      durableWrites: true,
      commitOutbox: true,
      commitOutboxScope: true,
      debug: true,
      logLevel: true,
      logger: true,
      authToken: true,
      baseURL: true,
      fetch: true,
      defaultHeaders: true,
      defaultQuery: true,
      dangerouslyAllowBrowser: true,
      collaborationEvents: true,
    };
    expect([...PUBLIC_ABLO_OPTION_KEYS].sort()).toEqual(Object.keys(sample).sort());
  });

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
