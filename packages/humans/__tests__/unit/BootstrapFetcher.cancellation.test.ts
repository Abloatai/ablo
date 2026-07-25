/**
 * @jest-environment node
 *
 * Runs in node (not jsdom): the fetch mocks build real `Response` objects,
 * which jsdom does not define. This is the same reason the sibling
 * `BootstrapFetcher.*` suites give.
 *
 * The bootstrap fetcher's concurrency contract: which requests are shared,
 * which are cancelled, and which of those cancellations are allowed to be
 * retried.
 *
 * These are the invariants behind a production failure in which one page load
 * issued dozens of overlapping `/sync/bootstrap` requests. Three callers reach
 * the fetcher independently — first load, background refresh, and reconnect —
 * and every one of them used to cancel whatever was running and start over,
 * while the cancelled requests, unable to tell a deliberate abort from a dead
 * socket, retried themselves. Each assertion below pins one link in that chain.
 */

import { BootstrapFetcher } from '../../src/local/sync/BootstrapFetcher';

const BASE_URL = 'https://api.example.com/api';

/** The `models` query parameter of a bootstrap URL, which is what identifies a
 *  chunk request. */
function modelOf(url: string): string {
  return new URL(url).searchParams.get('models') ?? '';
}

function syncGroupsOf(url: string): string[] {
  return new URL(url).searchParams.getAll('syncGroups');
}

function snapshot(model: string): unknown {
  return { type: 'full', lastSyncId: 7, models: { [model]: [] }, timestamp: 1 };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, statusText: 'OK' });
}

/**
 * A request that never completes on its own, and that honours its abort signal
 * the way the platform does: `fetch` rejects with the exact value passed to
 * `abort(reason)` rather than a generic `AbortError` (WHATWG Fetch § 5.6 —
 * "abort the fetch() call … reject promise with error"). Getting this right in
 * the double is the whole point, since the production bug was the fetcher being
 * unable to read that reason.
 */
function abortReasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

function hangUntilAborted(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(abortReasonOf(signal));
      return;
    }
    signal.addEventListener('abort', () => { reject(abortReasonOf(signal)); }, { once: true });
  });
}

/** The request URL, however the caller expressed it. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

describe('BootstrapFetcher — sharing and cancellation', () => {
  let originalFetch: typeof globalThis.fetch;
  let requested: string[];
  /** Per-model behaviour; anything unrouted returns an empty snapshot. */
  let routes: Map<string, (init?: RequestInit) => Promise<Response>>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    requested = [];
    routes = new Map();
    globalThis.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      requested.push(url);
      const route = routes.get(modelOf(url));
      return route ? route(init) : Promise.resolve(okResponse(snapshot(modelOf(url))));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const countFor = (model: string): number =>
    requested.filter((url) => modelOf(url) === model).length;

  it('joins a bootstrap already in flight rather than cancelling and restarting it', async () => {
    const helper = new BootstrapFetcher({
      baseUrl: BASE_URL,
      instantModels: ['Alpha', 'Beta'],
    });

    // Two callers, same question, same tick — the shape of a reconnect landing
    // in the middle of a cold start.
    const [first, second] = await Promise.all([
      helper.fetchBootstrap(),
      helper.fetchBootstrap(),
    ]);

    expect(first).toBe(second);
    expect(countFor('Alpha')).toBe(1);
    expect(countFor('Beta')).toBe(1);
  });

  it('starts a fresh bootstrap once the previous one has settled', async () => {
    const helper = new BootstrapFetcher({
      baseUrl: BASE_URL,
      instantModels: ['Alpha', 'Beta'],
    });

    await helper.fetchBootstrap();
    await helper.fetchBootstrap();

    // Joining is for concurrent callers only — it must not become a cache.
    expect(countFor('Alpha')).toBe(2);
  });

  it('does not retry a request it cancelled on purpose', async () => {
    let slowStarted: () => void = () => undefined;
    const slowInFlight = new Promise<void>((resolve) => { slowStarted = resolve; });
    routes.set('Slow', (init) => {
      slowStarted();
      return hangUntilAborted(init);
    });

    const helper = new BootstrapFetcher({
      baseUrl: BASE_URL,
      instantModels: ['Fast', 'Slow'],
      maxRetries: 3,
      retryDelay: 1,
    });

    const bootstrap = helper.fetchBootstrap();
    await slowInFlight;
    helper.abort();

    await expect(bootstrap).rejects.toMatchObject({ code: 'bootstrap_cancelled' });
    // The load-bearing assertion. With a bare `abort()` the rejection arrives as
    // an indistinguishable AbortError, the retry loop reads it as a transient
    // timeout, and this is 3.
    expect(countFor('Slow')).toBe(1);
  });

  it('still retries a request that failed on its own', async () => {
    let attempts = 0;
    routes.set('Flaky', () => {
      attempts++;
      return attempts < 3
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(okResponse(snapshot('Flaky')));
    });

    const helper = new BootstrapFetcher({
      baseUrl: BASE_URL,
      instantModels: ['Steady', 'Flaky'],
      maxRetries: 3,
      retryDelay: 1,
    });

    const data = await helper.fetchBootstrap();

    expect(attempts).toBe(3);
    expect(data.models?.Flaky).toEqual([]);
  });

  it('leaves a scoped hydrate alone when a bootstrap chunk fails', async () => {
    let releaseScoped: (() => void) | undefined;
    let scopedStarted: () => void = () => undefined;
    const scopedInFlight = new Promise<void>((resolve) => { scopedStarted = resolve; });

    globalThis.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      requested.push(url);
      // The scoped hydrate is the one carrying an explicit sync group.
      if (syncGroupsOf(url).includes('deck:1')) {
        scopedStarted();
        return new Promise<Response>((resolve, reject) => {
          releaseScoped = () => { resolve(okResponse(snapshot('Scoped'))); };
          const signal = init?.signal;
          signal?.addEventListener(
            'abort',
            () => { reject(abortReasonOf(signal)); },
            { once: true },
          );
        });
      }
      if (modelOf(url) === 'Boom') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(okResponse(snapshot(modelOf(url))));
    });

    const helper = new BootstrapFetcher({
      baseUrl: BASE_URL,
      instantModels: ['Fine', 'Boom'],
      maxRetries: 1,
      retryDelay: 1,
    });

    const scoped = helper.fetchBootstrap(undefined, ['deck:1']);
    await scopedInFlight;

    await expect(helper.fetchBootstrap()).rejects.toBeDefined();

    // The cold start abandoning its siblings must not reach across lanes — the
    // scoped hydrate answers a different question and is still wanted.
    releaseScoped?.();
    await expect(scoped).resolves.toMatchObject({ type: 'full' });
  });

  it('derives the attempt budget from its own watchdogs', () => {
    const helper = new BootstrapFetcher({
      baseUrl: BASE_URL,
      instantModels: ['A', 'B', 'C', 'D'],
      fetchTimeout: 1_000,
      stallTimeout: 500,
      maxRetries: 2,
    });

    // Four models at a concurrency of three is two waves; each request may spend
    // fetchTimeout on headers and stallTimeout on the body, and may be retried.
    expect(helper.budgetMs).toBe(2 * (1_000 + 500) * 2);
  });
});
