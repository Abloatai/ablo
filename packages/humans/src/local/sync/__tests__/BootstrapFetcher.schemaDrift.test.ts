/**
 * @jest-environment node
 *
 * Runs in node (not jsdom): the fetch mocks build real `Response` objects,
 * which jsdom 26 does not define.
 *
 * Schema-drift warning: the bootstrap response carries the server's ACTIVE
 * schema hash; the client compares it to the hash it was built against
 * (`config.expectedSchemaHash`) and warns once on a mismatch — so drift is
 * caught at connect time instead of later as an opaque DB constraint error.
 */
import { BootstrapFetcher } from '../BootstrapFetcher.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { Logger } from '../../interfaces/index.js';

function spyLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } satisfies Logger;
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Resolve a fetch argument to its URL string (a `Request` carries it as `.url`). */
function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function mockBootstrapFetch(body: Record<string, unknown>) {
  global.fetch = jest.fn(() => Promise.resolve(jsonResponse(body)));
}

const DRIFT = /Schema drift/;

function helper() {
  return new BootstrapFetcher({ baseUrl: 'http://test/api', maxRetries: 1 });
}

describe('BootstrapFetcher schema-drift warning', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('warns when the server hash differs from the client hash', async () => {
    const logger = spyLogger();
    createTestContext({ logger, config: { expectedSchemaHash: 'client_aaa' } });
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {}, schemaHash: 'server_bbb' });

    await helper().fetchBootstrap();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(DRIFT),
      expect.objectContaining({ clientSchemaHash: 'client_aaa', serverSchemaHash: 'server_bbb' }),
    );
  });

  it('names the server it connected to and points to `ablo status` to disambiguate the target', async () => {
    const logger = spyLogger();
    createTestContext({ logger, config: { expectedSchemaHash: 'client_aaa' } });
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {}, schemaHash: 'server_bbb' });

    await helper().fetchBootstrap();

    const [msg, meta] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    // The server URL is named in the message and the structured metadata — the
    // fact that instantly exposes a wrong-server/wrong-target split.
    expect(msg).toContain('http://test/api');
    expect(meta).toMatchObject({ serverUrl: 'http://test/api' });
    // The load-bearing pointer is `ablo status` (target), not only `ablo push`.
    expect(msg).toContain('`ablo status`');
    expect(msg).toContain('`ablo push`');
  });

  it('does NOT warn when the hashes match', async () => {
    const logger = spyLogger();
    createTestContext({ logger, config: { expectedSchemaHash: 'same_hash' } });
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {}, schemaHash: 'same_hash' });

    await helper().fetchBootstrap();

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(DRIFT), expect.anything());
  });

  it('does NOT warn for a projection when the server matches its SOURCE hash', async () => {
    // A `selectModels`/`omitModels` client hashes its subset (`expectedSchemaHash`)
    // but also carries the full source's hash (`expectedSourceSchemaHash`). The
    // server runs that full source schema, so its hash equals the source hash,
    // not the subset hash — a faithful subset, not drift.
    const logger = spyLogger();
    createTestContext({
      logger,
      config: { expectedSchemaHash: 'subset_66ef', expectedSourceSchemaHash: 'canonical_bea1' },
    });
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {}, schemaHash: 'canonical_bea1' });

    await helper().fetchBootstrap();

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(DRIFT), expect.anything());
  });

  it('DOES warn for a projection when neither its own nor its source hash matches', async () => {
    // Real drift: the server runs an older source schema than the one this subset
    // was cut from, so neither the subset hash nor the source hash matches. The
    // source-hash allowance must not swallow a genuinely behind server.
    const logger = spyLogger();
    createTestContext({
      logger,
      config: { expectedSchemaHash: 'subset_66ef', expectedSourceSchemaHash: 'canonical_bea1' },
    });
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {}, schemaHash: 'older_cd2d' });

    await helper().fetchBootstrap();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(DRIFT),
      expect.objectContaining({ clientSchemaHash: 'subset_66ef', serverSchemaHash: 'older_cd2d' }),
    );
  });

  it('does NOT warn when the server omits a hash (older server / no pushed schema)', async () => {
    const logger = spyLogger();
    createTestContext({ logger, config: { expectedSchemaHash: 'client_aaa' } });
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {} });

    await helper().fetchBootstrap();

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(DRIFT), expect.anything());
  });

  it('does NOT warn when the client has no expected hash (older client)', async () => {
    const logger = spyLogger();
    createTestContext({ logger }); // no expectedSchemaHash
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {}, schemaHash: 'server_bbb' });

    await helper().fetchBootstrap();

    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringMatching(DRIFT), expect.anything());
  });

  it('warns at most once even across repeated bootstraps', async () => {
    const logger = spyLogger();
    createTestContext({ logger, config: { expectedSchemaHash: 'client_aaa' } });
    mockBootstrapFetch({ type: 'full', lastSyncId: 0, models: {}, schemaHash: 'server_bbb' });

    const h = helper();
    await h.fetchBootstrap();
    await h.fetchBootstrap();

    const driftCalls = logger.warn.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('Schema drift'),
    );
    expect(driftCalls).toHaveLength(1);
  });
});

/** Fetch mock dispatching by URL: bootstrap body for /sync/bootstrap, the
 *  per-model schema surface for /schema — the pair the semantic check reads. */
function mockBootstrapAndSchemaFetch(
  bootstrapBody: Record<string, unknown>,
  schemaBody: Record<string, unknown>,
) {
  global.fetch = jest.fn((input: RequestInfo | URL) =>
    Promise.resolve(jsonResponse(requestUrl(input).includes('/schema') ? schemaBody : bootstrapBody)),
  );
}

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

describe('semantic drift — per-model comparison replaces the whole-hash weld', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stays SILENT when the hash differs only because the server gained models this build never uses', async () => {
    const logger = spyLogger();
    createTestContext({
      logger,
      config: {
        expectedSchemaHash: 'client_66ef',
        expectedModelHashes: { tasks: 'aaaa1111', slides: 'bbbb2222' },
      },
    });
    mockBootstrapAndSchemaFetch(
      { type: 'full', lastSyncId: 0, models: {}, schemaHash: 'server_bea1' },
      {
        models: [
          { key: 'tasks', hash: 'aaaa1111' },
          { key: 'slides', hash: 'bbbb2222' },
          { key: 'mailThreads', hash: 'cccc3333' }, // the additive push
        ],
      },
    );

    await helper().fetchBootstrap();
    await flushAsync();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('names the exact models when a declared model genuinely differs — no hex in the message', async () => {
    const logger = spyLogger();
    createTestContext({
      logger,
      config: {
        expectedSchemaHash: 'client_66ef',
        expectedModelHashes: { tasks: 'aaaa1111', slides: 'bbbb2222' },
      },
    });
    mockBootstrapAndSchemaFetch(
      { type: 'full', lastSyncId: 0, models: {}, schemaHash: 'server_bea1' },
      { models: [{ key: 'tasks', hash: 'aaaa1111' }, { key: 'slides', hash: 'CHANGED0' }] },
    );

    await helper().fetchBootstrap();
    await flushAsync();

    const [msg, meta] = logger.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toContain('slides');
    expect(msg).not.toContain('tasks,'); // the matching model is not implicated
    expect(meta).toMatchObject({ changedModels: ['slides'] });
  });

  it('falls back to the whole-hash message when the server surface has no per-model hashes', async () => {
    const logger = spyLogger();
    createTestContext({
      logger,
      config: {
        expectedSchemaHash: 'client_66ef',
        expectedModelHashes: { tasks: 'aaaa1111' },
      },
    });
    mockBootstrapAndSchemaFetch(
      { type: 'full', lastSyncId: 0, models: {}, schemaHash: 'server_bea1' },
      { models: [{ key: 'tasks' }] }, // older server: keys only
    );

    await helper().fetchBootstrap();
    await flushAsync();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(DRIFT), expect.anything());
  });
});
