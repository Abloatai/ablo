/**
 * Type-level tests for the typed-global augmentation point.
 *
 * These are Jest-runnable but do no runtime work — they exist to catch
 * regressions in the resolver chain at `tsc` time. The `// @ts-expect-error`
 * assertions fail the build if the expected type narrowing stops working.
 *
 * We can't test "not registered" and "registered" in the SAME file because
 * TypeScript merges the `Register` augmentation across the whole compilation —
 * un-registering it for a subsection is impossible. Instead, this file tests
 * the behavior WHEN `Register` IS augmented (the non-default case); the default
 * fallback to `DefaultSyncShape` is guaranteed at the source level.
 */

import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import { defineSchema, model, relation } from '../../schema/index.js';
import type {
  ResolveSchema,
  ResolveUserMeta,
  ResolveModelKey,
  DefaultSyncShape,
} from '@abloatai/transaction/types/global';
import type { Claim, ClaimTarget, HeldClaim } from '@abloatai/transaction/types/streams';
import type { Identical } from './typeEquality.js';

// Build a fixture schema locally. The module augmentation below binds
// `Register['Schema']` to this fixture's `typeof schema` so downstream
// resolvers produce the fixture's concrete model types.
const fixtureSchema = defineSchema({
  tasks: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'done']).default('todo'),
    },
    {
      relations: {
        comments: relation.hasMany('comments', 'taskId'),
      },
      typename: 'Task',
    }),
  comments: model(
    { taskId: z.string(), body: z.string() },
    {
      relations: { task: relation.belongsTo('tasks', 'taskId') },
      typename: 'Comment',
    }),
});

// An application writes `declare module '@abloatai/ablo'` — the published name.
// Inside the repo that specifier resolves to nothing, and an augmentation of an
// unresolved module silently becomes an ambient declaration that merges with
// nothing, so the tests spell the workspace name.
declare module '@abloatai/transaction/types/global' {
  interface Register {
    Schema: typeof fixtureSchema;
    UserMeta: { id: string; email: string };
  }
}

// ── Compile-time assertions ──────────────────────────────────────────────
// These are pure type checks. If any of these stop holding, `tsc` fails.
// The `_` prefix on the helper suppresses "unused" warnings — declaring
// the type is the whole test.

type _AssertSchemaResolvesToFixture = ResolveSchema extends typeof fixtureSchema
  ? true
  : false;
const _schemaOk: _AssertSchemaResolvesToFixture = true;

type _AssertUserMetaResolvesToFixture = ResolveUserMeta extends {
  id: string;
  email: string;
}
  ? true
  : false;
const _userMetaOk: _AssertUserMetaResolvesToFixture = true;

// ── Claim metadata ───────────────────────────────────────────────────────
// The `ClaimMeta` slot is deliberately NOT part of the fixture augmentation
// above. A `Register` augmentation merges across the whole compilation, so
// declaring one narrow claim-meta shape here would make every claim fixture in
// this package — the wire-shaped targets the locator and contention suites
// build — the wrong shape. A registration IS proven, in the one place where a
// second `Register` can exist: `typetests/registeredClaimMeta.ts`, its own
// `tsc` program (`npm run typecheck:types`), where a narrow shape is declared
// and then read off both the write surface and the read surface.
//
// What this file pins is the other half — the answer for a program that
// registers nothing.

// Two-way, and invariant: the fallback must stay exactly the loose record an
// unregistered program already reads. One-way `extends` still passes if the
// fallback is widened to `unknown`, and a plain conditional degenerates to
// `boolean` — satisfying the assertion — if it is widened to `any`. Those two
// widenings are what global.ts says this slot must never be.
type _AssertClaimMetaFallbackStaysLoose = Identical<
  DefaultSyncShape['ClaimMeta'],
  Record<string, unknown>
>;
const _claimMetaFallbackOk: _AssertClaimMetaFallbackStaysLoose = true;

// The per-call override stays a working, published surface — `state<M>` and
// `queue<M>` hand their `M` down this path. Each of these fails to compile,
// not merely to hold, if the parameter is dropped from the interface it names.
interface Blocks {
  blocks: string[];
}

type _AssertTargetTakesAnOverride =
  NonNullable<ClaimTarget<Blocks>['meta']> extends Blocks ? true : false;
const _targetOverrideOk: _AssertTargetTakesAnOverride = true;

type _AssertClaimThreadsTheOverride =
  NonNullable<Claim<Record<string, unknown>, Blocks>['target']['meta']> extends
    Blocks
    ? true
    : false;
const _claimOverrideOk: _AssertClaimThreadsTheOverride = true;

// A held claim used to drop the parameter, so `await using held = …` read an
// untyped `held.target.meta` no matter what the program declared.
type _AssertHeldClaimKeepsTheOverride =
  NonNullable<
    HeldClaim<Record<string, unknown>, Blocks>['target']['meta']
  > extends Blocks
    ? true
    : false;
const _heldOverrideOk: _AssertHeldClaimKeepsTheOverride = true;

// Model key union should be the literal 'tasks' | 'comments' — anything
// else would mean the key narrowing leaked to `string`, which would break
// the call-site ergonomics (`useQuery('tasks')` auto-completing to the
// schema's keys).
type _AssertModelKeyIsNarrowed = ResolveModelKey extends 'tasks' | 'comments'
  ? true
  : false;
const _modelKeyOk: _AssertModelKeyIsNarrowed = true;

// Default fallback shape is still reachable by name for consumers that
// want to express "no typed augmentation" without repeating the shape.
type _AssertDefaultShape = DefaultSyncShape['Schema'] extends {
  models: Record<string, unknown>;
}
  ? true
  : false;
const _defaultOk: _AssertDefaultShape = true;

describe('typed-global resolvers', () => {
  it('compile-time assertions pass', () => {
    // The real test is the `_...Ok` const declarations above — they
    // fail `tsc` if the resolver chain regresses. At runtime we just
    // confirm the fixture schema was actually built.
    expect(fixtureSchema.models.tasks).toBeDefined();
    expect(fixtureSchema.models.comments).toBeDefined();
    expect(_schemaOk).toBe(true);
    expect(_userMetaOk).toBe(true);
    expect(_modelKeyOk).toBe(true);
    expect(_defaultOk).toBe(true);
    expect(_claimMetaFallbackOk).toBe(true);
    expect(_targetOverrideOk).toBe(true);
    expect(_claimOverrideOk).toBe(true);
    expect(_heldOverrideOk).toBe(true);
  });
});
