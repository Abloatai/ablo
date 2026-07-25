/**
 * BaseSyncedStore.hydrateGroups + enterScope({ hydrate }) — P4b.
 *
 * Pins the orchestration around the (P4a) scoped apply:
 *   - hydrateGroups fetches a PURE scoped snapshot and applies it via the
 *     scoped path ({ scoped: true }), marking groups hydrated.
 *   - idempotent (skips already-hydrated groups) + single-flight (concurrent
 *     enters of the same group share one fetch).
 *   - soft-fail: a failed fetch does NOT mark hydrated, so a re-enter retries.
 *   - enterScope subscribes FIRST, then hydrates (no live delta missed in the
 *     gap); without { hydrate } it never fetches.
 *
 * Uses the `Object.create(prototype)` shell idiom to exercise the methods with
 * stubbed collaborators, no heavy constructor.
 */

import { BaseSyncedStore } from '../../src/local/BaseSyncedStore';
import { globalRuntime } from '../../src/local/context.js';
import { createTestContext, type TestContextResult } from '../../src/local/testing';

interface Shell {
  database: { fetchScopedBootstrapData: jest.Mock };
  syncClient: { applyBootstrapDataToPool: jest.Mock };
  areaOfInterest: { enter: jest.Mock } | null;
  schema: undefined;
  hydratedGroups: Set<string>;
  hydratingGroups: Map<string, Promise<void>>;
  hydrateGroups(groups: readonly string[]): Promise<void>;
  enterScope(scope: string, opts?: { hydrate?: boolean }): Promise<void>;
}

function makeShell(over: Partial<Shell> = {}): Shell {
  const shell = Object.create(BaseSyncedStore.prototype) as Shell;
  (shell as Record<string, unknown>).runtime = globalRuntime;
  // Class field initializers are skipped by Object.create — the durable
  // socket-subscription registry must exist before setupWebSocketSync or
  // disconnect runs.
  (shell as Record<string, unknown>).socketSubscriptions = new Map();
  shell.hydratedGroups = new Set();
  shell.hydratingGroups = new Map();
  shell.schema = undefined;
  shell.areaOfInterest = null;
  shell.database = { fetchScopedBootstrapData: jest.fn().mockResolvedValue({ models: {} }) };
  shell.syncClient = { applyBootstrapDataToPool: jest.fn() };
  Object.assign(shell, over);
  return shell;
}

describe('BaseSyncedStore.hydrateGroups (P4b)', () => {
  let ctx: TestContextResult;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { ctx.cleanup(); });

  it('fetches a scoped snapshot and applies it via the scoped path, marking hydrated', async () => {
    const data = { models: { Task: [] } };
    const shell = makeShell({
      database: { fetchScopedBootstrapData: jest.fn().mockResolvedValue(data) },
    });

    await shell.hydrateGroups(['deck:a']);

    expect(shell.database.fetchScopedBootstrapData).toHaveBeenCalledWith(['deck:a']);
    expect(shell.syncClient.applyBootstrapDataToPool).toHaveBeenCalledWith(
      data,
      undefined,
      { scoped: true },
    );
    expect(shell.hydratedGroups.has('deck:a')).toBe(true);
  });

  it('is idempotent — an already-hydrated group is not re-fetched', async () => {
    const shell = makeShell();
    await shell.hydrateGroups(['deck:a']);
    await shell.hydrateGroups(['deck:a']);
    expect(shell.database.fetchScopedBootstrapData).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent hydrations of the same group into one fetch', async () => {
    let release!: (v: { models: object }) => void;
    const fetch = jest.fn(
      () => new Promise<{ models: object }>((r) => { release = r; }),
    );
    const shell = makeShell({ database: { fetchScopedBootstrapData: fetch } });

    const p1 = shell.hydrateGroups(['deck:a']);
    const p2 = shell.hydrateGroups(['deck:a']);
    release({ models: {} });
    await Promise.all([p1, p2]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('soft-fails — a failed fetch leaves the group un-hydrated and a re-enter retries', async () => {
    const fetch = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ models: {} });
    const shell = makeShell({ database: { fetchScopedBootstrapData: fetch } });

    await shell.hydrateGroups(['deck:a']); // fails — must not throw
    expect(shell.hydratedGroups.has('deck:a')).toBe(false);

    await shell.hydrateGroups(['deck:a']); // retries
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(shell.hydratedGroups.has('deck:a')).toBe(true);
  });
});

describe('BaseSyncedStore.enterScope({ hydrate }) (P4b)', () => {
  let ctx: TestContextResult;
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { ctx.cleanup(); });

  it('subscribes FIRST, then hydrates (no delta missed in the gap)', async () => {
    const order: string[] = [];
    const enter = jest.fn(async (g: string) => { order.push(`enter:${g}`); });
    const fetch = jest.fn(async () => { order.push('fetch'); return { models: {} }; });
    const shell = makeShell({
      areaOfInterest: { enter },
      database: { fetchScopedBootstrapData: fetch },
    });

    await shell.enterScope('deck:a', { hydrate: true });

    expect(order).toEqual(['enter:deck:a', 'fetch']);
  });

  it('does NOT fetch when hydrate is not requested', async () => {
    const shell = makeShell({
      areaOfInterest: { enter: jest.fn().mockResolvedValue(undefined) },
    });

    await shell.enterScope('deck:a');

    expect(shell.database.fetchScopedBootstrapData).not.toHaveBeenCalled();
  });
});
