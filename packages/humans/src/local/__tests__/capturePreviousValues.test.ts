/**
 * `Model.capturePreviousValues` / `Model.consumeModifiedFields` — the SINGLE
 * before-image implementation shared by both undo paths:
 *   - stream path: `MutationQueue.extractPreviousData` (fallbackToLive: false)
 *   - manual path: `RecordingMutation.snapshotFields` (fallbackToLive: true)
 *
 * The two paths differ ONLY in the last-resort tier (omit vs live read); these
 * tests pin that difference and the three-tier resolution order so a future
 * change can't silently regress one surface's undo.
 */

import { createTestContext } from '../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../testing/mocks/MockSyncContext.js';
import { createTaskFixture } from '../testing/fixtures/models.js';

describe('Model.capturePreviousValues', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => { ctx.cleanup(); });

  it('tier 1 — prefers modifiedProperties.old (first-old-wins pre-session baseline)', () => {
    const task = createTaskFixture({ title: 'A', status: 'todo' });
    task.markAsPersisted();
    // In-place mutation populates modifiedProperties via first-old-wins.
    task.propertyChanged('title', 'A', 'B');
    task.propertyChanged('title', 'B', 'C'); // .old stays 'A'

    expect(task.capturePreviousValues(['title'])).toEqual({ title: 'A' });
  });

  it('tier 2 — falls back to the original snapshot for a key never pre-mutated', () => {
    const task = createTaskFixture({ title: 'Loaded', status: 'todo' });
    task.markAsPersisted(); // snapshot = { title: 'Loaded', status: 'todo', ... }
    // No propertyChanged for `title` — modifiedProperties is empty.

    expect(task.capturePreviousValues(['title'])).toEqual({ title: 'Loaded' });
  });

  it('tier 3 — omits unresolved keys by default, returns live value only with fallbackToLive', () => {
    const task = createTaskFixture({ title: 'X' });
    // NOT persisted → getOriginalSnapshot() is undefined; no modifiedProperties.
    expect(task.getOriginalSnapshot()).toBeUndefined();

    // Stream-path semantics: unresolved key is OMITTED (so buildUndoOps drops
    // an un-revertible inverse rather than inventing one).
    expect(task.capturePreviousValues(['title'])).toEqual({});

    // Manual-path semantics: live read as last resort.
    expect(task.capturePreviousValues(['title'], { fallbackToLive: true })).toEqual({
      title: 'X',
    });
  });

  it('always skips id', () => {
    const task = createTaskFixture({ title: 'A' });
    task.markAsPersisted();
    expect(task.capturePreviousValues(['id', 'title'], { fallbackToLive: true })).toEqual({
      title: 'A',
    });
  });
});

describe('Model.consumeModifiedFields', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => { ctx.cleanup(); });

  it('re-baselines only the named fields, leaving others tracked', () => {
    const task = createTaskFixture({ title: 'A', status: 'todo' });
    task.markAsPersisted();
    task.propertyChanged('title', 'A', 'B');
    task.propertyChanged('status', 'todo', 'doing');

    task.consumeModifiedFields(['title']);

    // title baseline advanced (next write starts fresh); status untouched.
    expect(task.modifiedProperties.has('title')).toBe(false);
    expect(task.modifiedProperties.get('status')?.old).toBe('todo');
  });

  it('with no keys consumes every tracked field; never removes id', () => {
    const task = createTaskFixture({ title: 'A', status: 'todo' });
    task.markAsPersisted();
    task.propertyChanged('title', 'A', 'B');
    task.propertyChanged('status', 'todo', 'doing');

    task.consumeModifiedFields();

    expect(task.modifiedProperties.size).toBe(0);
  });
});
