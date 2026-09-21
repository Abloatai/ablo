/** @jest-environment node */
import { BootstrapFetcher } from '../../src/local/sync/BootstrapFetcher';

const rejected = (retryAfter = '1') => new Response(JSON.stringify({
  type: 'AbloConnectionError', code: 'instance_at_capacity', message: 'Retry shortly.',
}), { status: 503, headers: { 'Retry-After': retryAfter } });
const ready = () => new Response(JSON.stringify({
  type: 'partial', lastSyncId: 340947, deltas: [], timestamp: 1,
}));

describe('bootstrap capacity recovery', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

  it('survives a nine-second protection window with the default attempt limit', async () => {
    const started = Date.now();
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(Date.now() - started < 9_000 ? rejected() : ready()));
    const helper = new BootstrapFetcher({ baseUrl: 'https://example.com/api' });
    const result = helper.fetchBootstrap(340940, ['repository:1']);
    void result.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(9_000);
    await expect(result).resolves.toMatchObject({ lastSyncId: 340947 });
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(new Set(fetch.mock.calls.map(([url]) => url)).size).toBe(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('waits for Retry-After and cancels without issuing another request', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(rejected('10')));
    const helper = new BootstrapFetcher({});
    const result = helper.fetchBootstrap();
    const cancelled = expect(result).rejects.toMatchObject({ code: 'bootstrap_cancelled' });
    await jest.advanceTimersByTimeAsync(9_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    helper.abort();
    await cancelled;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops capacity retries at the bounded recovery deadline', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(rejected('3')));
    const helper = new BootstrapFetcher({ fetchTimeout: 10_000 });
    const result = expect(helper.fetchBootstrap()).rejects.toMatchObject({
      code: 'instance_at_capacity', retryAfterSeconds: 3,
    });
    await jest.advanceTimersByTimeAsync(10_000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('keeps the attempt limit for ordinary network failures', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const result = expect(new BootstrapFetcher({}).fetchBootstrap()).rejects.toBeDefined();
    await jest.advanceTimersByTimeAsync(20_000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves retry metadata for ETag and entity callers', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(rejected('10')));
    const helper = new BootstrapFetcher({});
    await expect(helper.fetchBootstrapWithETag()).rejects.toMatchObject({ retryAfterSeconds: 10 });
    await expect(helper.fetchEntity('tasks', '1')).rejects.toMatchObject({ retryAfterSeconds: 10 });
  });

  it('sends large scopes in the body for paged and conditional bootstraps', async () => {
    const groups = Array.from({ length: 100 }, (_, i) => `repository:${i}:${'x'.repeat(90)}`);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(ready()));
    const helper = new BootstrapFetcher({ baseUrl: 'https://example.com/api', syncGroups: groups, instantModels: ['tasks'] });

    await helper.fetchBootstrap();
    await helper.fetchBootstrapWithETag();

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      const requestUrl = url as string;
      expect(requestUrl.length).toBeLessThan(8_000);
      expect(requestUrl).toContain('models=tasks');
      expect(requestUrl).not.toContain('syncGroups=');
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ syncGroups: groups }) });
    }
  });

  it('keeps per-model page URLs short with a large scope', async () => {
    const groups = Array.from({ length: 100 }, (_, i) => `repository:${i}:${'x'.repeat(90)}`);
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      type: 'full', lastSyncId: 1, models: {}, timestamp: 1,
    }))));
    const helper = new BootstrapFetcher({
      baseUrl: 'https://example.com/api', syncGroups: groups, instantModels: ['tasks', 'sourceHeads'],
    });

    await helper.fetchBootstrap();

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetch.mock.calls) {
      const requestUrl = url as string;
      expect(requestUrl.length).toBeLessThan(8_000);
      expect(requestUrl).toContain('limit=5000');
      expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ syncGroups: groups }) });
    }
  });
});
