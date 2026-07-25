/**
 * `postQuery` swallows HTTP failures (fire-and-forget — a throw here would
 * kill the Next.js router on an unhandled rejection), but the failure must
 * still be LEGIBLE.
 *
 * Since the consumer log-DX pass it routes through the gated logger in two
 * registers (see docs/plans/sync-engine-consumer-log-dx.md):
 *   • a default-visible `warn` in the CONSUMER register — their models, the
 *     typed error's human message, and a wire `code`. No engine vocabulary.
 *   • a `debug` companion in the MAINTAINER register carrying the typed class
 *     (`type`) + `code` — so the 401 the sidebar hit is still legible as
 *     `AbloAuthenticationError`/`session_expired` for whoever's debugging.
 * Index alignment (one empty slot per query) is preserved on both paths.
 */

import { postQuery } from '../client.js';
import type { QueryBatch } from '../types.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import type { TestContextResult } from '../../testing/mocks/MockSyncContext.js';
import type { Logger } from '../../interfaces/index.js';

const batch = {
  queries: [{ model: 'File' }, { model: 'Folder' }],
} as unknown as QueryBatch;

/** Minimal fake of the Response surface `postQuery` touches (`ok`, `status`,
 *  `statusText`, `clone().json()`). The jest env has no global `Response`. */
function fakeResponse(status: number, body: unknown, jsonThrows = false) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => {
      if (jsonThrows) throw new Error('not json');
      return body;
    },
    clone() {
      return res;
    },
  };
  return res;
}

function mockFetchOnce(status: number, body: unknown, jsonThrows = false): void {
  global.fetch = (() =>
    Promise.resolve(fakeResponse(status, body, jsonThrows))) as unknown as typeof fetch;
}

function spyLogger(): Logger & {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
} {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/** Concatenate a mock logger method's first-arg strings for substring asserts. */
function texts(mock: jest.Mock): string {
  return mock.mock.calls.map((c) => String(c[0])).join('\n');
}

/** Concatenate the JSON of a mock logger method's structured second args. */
function details(mock: jest.Mock): string {
  return mock.mock.calls.map((c) => JSON.stringify(c[1] ?? {})).join('\n');
}

describe('postQuery — failures are legible across both log registers', () => {
  const original = global.fetch;
  let ctx: TestContextResult;
  let logger: ReturnType<typeof spyLogger>;

  beforeEach(() => {
    logger = spyLogger();
    ctx = createTestContext({ logger });
  });
  afterEach(() => {
    ctx.cleanup();
    global.fetch = original;
  });

  it('401 → consumer warn (models + code) + debug companion tagging AbloAuthenticationError, one empty slot per query', async () => {
    mockFetchOnce(401, { type: 'AbloAuthenticationError', code: 'session_expired', message: 'nope' });

    const result = await postQuery({ baseUrl: 'https://x.example/api' }, batch);

    // Index alignment preserved — no throw.
    expect(result.results).toEqual([[], []]);

    // Consumer register: their models + the wire code, no engine nouns.
    const warned = texts(logger.warn);
    expect(warned).toContain('File');
    expect(warned).toContain('Folder');
    expect(warned).toContain('session_expired');
    expect(warned).not.toContain('[postQuery'); // no internal module tag leaks

    // Maintainer register: the typed class is still legible on debug.
    const dbg = texts(logger.debug) + '\n' + details(logger.debug);
    expect(dbg).toContain('AbloAuthenticationError');
    expect(dbg).toContain('session_expired');
  });

  it('500 with a non-JSON body still tags as AbloServerError on the debug companion', async () => {
    mockFetchOnce(500, null, /* jsonThrows */ true);

    const result = await postQuery({ baseUrl: 'https://x.example/api' }, batch);
    expect(result.results).toEqual([[], []]);

    expect(texts(logger.debug) + '\n' + details(logger.debug)).toContain('AbloServerError');
  });
});
