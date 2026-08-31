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
import { createItemFixture } from '../testing/fixtures/models.js';

describe('Model.capturePreviousValues', () => {
  let ctx: TestContextResult;

  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => { ctx.cleanup(); });

  it('tier 1 — prefers modifiedProperties.old (first-old-wins pre-session baseline)', () => {
    const item = createItemFixture({ title: 'A', status: 'todo' });
    item.markAsPersisted();
    // In-place mutation populates modifiedProperties via first-old-wins.
    item.propertyChanged('title', 'A', 'B');
    item.propertyChanged('title', 'B', 'C'); // .old stays 'A'

    expect(item.capturePreviousValues(['title'])).toEqual({ title: 'A' });
  });

  it('captures and consumes an activated observable model update', () => {
    const item = createItemFixture({ title: 'A', status: 'todo' });
    item.markAsPersisted();
    item.ensureObservable();
    item.applyChanges({ title: 'B' });

    expect(item.capturePreviousValues(['title'])).toEqual({ title: 'A' });

    item.consumeModifiedFields(['title']);
    expect(item.hasChanges).toBe(false);
  });

  it('tier 2 — falls back to the original snapshot for a key never pre-mutated', () => {
    const item = createItemFixture({ title: 'Loaded', status: 'todo' });
    item.markAsPersisted(); // snapshot = { title: 'Loaded', status: 'todo', ... }
    // No propertyChanged for `title` — modifiedProperties is empty.

    expect(item.capturePreviousValues(['title'])).toEqual({ title: 'Loaded' });
  });

  it('tier 3 — omits unresolved keys by default, returns live value only with fallbackToLive', () => {
    const item = createItemFixture({ title: 'X' });
    // NOT persisted → getOriginalSnapshot() is undefined; no modifiedProperties.
    expect(item.getOriginalSnapshot()).toBeUndefined();

    // Stream-path semantics: unresolved key is OMITTED (so buildUndoOps drops
    // an un-revertible inverse rather than inventing one).
    expect(item.capturePreviousValues(['title'])).toEqual({});

    // Manual-path semantics: live read as last resort.
    expect(item.capturePreviousValues(['title'], { fallbackToLive: true })).toEqual({
      title: 'X',
    });
  });

  it('always skips id', () => {
    const item = createItemFixture({ title: 'A' });
    item.markAsPersisted();
    expect(item.capturePreviousValues(['id', 'title'], { fallbackToLive: true })).toEqual({
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
    const item = createItemFixture({ title: 'A', status: 'todo' });
    item.markAsPersisted();
    item.propertyChanged('title', 'A', 'B');
    item.propertyChanged('status', 'todo', 'doing');

    item.consumeModifiedFields(['title']);

    // title baseline advanced (next write starts fresh); status untouched.
    expect(item.modifiedProperties.has('title')).toBe(false);
    expect(item.modifiedProperties.get('status')?.old).toBe('todo');
  });

  it('with no keys consumes every tracked field; never removes id', () => {
    const item = createItemFixture({ title: 'A', status: 'todo' });
    item.markAsPersisted();
    item.propertyChanged('title', 'A', 'B');
    item.propertyChanged('status', 'todo', 'doing');

    item.consumeModifiedFields();

    expect(item.modifiedProperties.size).toBe(0);
  });
});
