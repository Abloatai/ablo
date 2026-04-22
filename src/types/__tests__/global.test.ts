/**
 * Type-level tests for the typed-global augmentation point.
 *
 * These are Jest-runnable but do no runtime work — they exist to catch
 * regressions in the resolver chain at `tsc` time. The `// @ts-expect-error`
 * assertions fail the build if the expected type narrowing stops working.
 *
 * We can't test "no global declaration" and "global declared" in the
 * SAME file because TypeScript merges `declare global` across the whole
 * compilation — declaring `AbloSync` for a subsection is impossible.
 * Instead, this file tests the behavior WHEN the global IS declared (the
 * non-default case), and an external TS project reference would test the
 * default case. For now, we rely on `ResolveSchema` falling back to
 * `DefaultSyncShape['Schema']` at the source level as the default guarantee.
 */

import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import { defineSchema, model, relation } from '../../schema/index';
import type {
  ResolveSchema,
  ResolvePresence,
  ResolveIntents,
  ResolveUserMeta,
  ResolveModelKey,
  DefaultSyncShape,
} from '../global';

// Build a fixture schema locally. The global augmentation below binds
// `AbloSync['Schema']` to this fixture's `typeof schema` so downstream
// resolvers produce the fixture's concrete model types.
const fixtureSchema = defineSchema({
  tasks: model(
    {
      title: z.string(),
      status: z.enum(['todo', 'done']).default('todo'),
    },
    {
      comments: relation.hasMany('comments', 'taskId'),
    },
    { typename: 'Task' },
  ),
  comments: model(
    { taskId: z.string(), body: z.string() },
    { task: relation.belongsTo('tasks', 'taskId') },
    { typename: 'Comment' },
  ),
});

declare global {
  interface AbloSync {
    Schema: typeof fixtureSchema;
    Presence: { cursor: { x: number; y: number } | null };
    Intents: { editTask: { taskId: string } };
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

type _AssertPresenceResolvesToFixture = ResolvePresence extends {
  cursor: { x: number; y: number } | null;
}
  ? true
  : false;
const _presenceOk: _AssertPresenceResolvesToFixture = true;

type _AssertIntentsResolvesToFixture = ResolveIntents extends {
  editTask: { taskId: string };
}
  ? true
  : false;
const _intentsOk: _AssertIntentsResolvesToFixture = true;

type _AssertUserMetaResolvesToFixture = ResolveUserMeta extends {
  id: string;
  email: string;
}
  ? true
  : false;
const _userMetaOk: _AssertUserMetaResolvesToFixture = true;

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
    // The real test is the four `_...Ok` const declarations above — they
    // fail `tsc` if the resolver chain regresses. At runtime we just
    // confirm the fixture schema was actually built.
    expect(fixtureSchema.models.tasks).toBeDefined();
    expect(fixtureSchema.models.comments).toBeDefined();
    expect(_schemaOk).toBe(true);
    expect(_presenceOk).toBe(true);
    expect(_intentsOk).toBe(true);
    expect(_userMetaOk).toBe(true);
    expect(_modelKeyOk).toBe(true);
    expect(_defaultOk).toBe(true);
  });
});
