/**
 * `new Ablo(...)` surface test.
 *
 * Locks in the Stripe / OpenAI / Anthropic-style class constructor
 * entrypoint. Mirrors the existing `createMesh` surface test and adds
 * one extra assertion: `new Ablo(opts)` produces an instance whose
 * runtime shape is indistinguishable from `createMesh(opts)`. The
 * constructor-return trick in `Ablo.ts` makes this true at runtime;
 * this test would catch a future refactor that broke parity.
 */

import { describe, it, expect } from '@jest/globals';
import { Ablo, createMesh } from '../../../src/mesh';
import Default from '../../../src/index';
import { defineSchema, mutable, z } from '../../../src/schema';

const schema = defineSchema({
  matters: mutable.lazy(
    { name: z.string() },
    { typename: 'Matter', tableName: 'matters', syncGroupFormat: 'matter:{id}' },
  ),
});

const opts = {
  schema,
  baseURL: 'https://sync.example.com',
  organizationId: 'org_test',
  apiKey: 'sk_test_123',
} as const;

describe('new Ablo(opts)', () => {
  it('constructs a working mesh client', () => {
    const ablo = new Ablo(opts);
    expect(typeof ablo.join).toBe('function');
    expect(typeof ablo.describeJoin).toBe('function');
    expect(ablo.schema).toBe(schema);
    expect(typeof ablo.admin.capabilities.create).toBe('function');
  });

  it('has the same runtime shape as createMesh(opts)', () => {
    const fromClass = new Ablo(opts);
    const fromFactory = createMesh(opts);
    // Both reach the same implementation; the class constructor
    // returns the createMesh result. Exposed field set must match.
    expect(Object.keys(fromClass).sort()).toEqual(
      Object.keys(fromFactory).sort(),
    );
  });

  it('is reachable as the package default export', () => {
    // `import Ablo from '@ablo/sync-engine'` resolves to the same class.
    expect(Default).toBe(Ablo);
    const ablo = new Default(opts);
    expect(typeof ablo.join).toBe('function');
  });
});
