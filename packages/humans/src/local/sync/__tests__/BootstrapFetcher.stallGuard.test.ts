/**
 * @jest-environment node
 *
 * Runs in node (not jsdom): these tests build real `Response` objects with
 * `ReadableStream` bodies, which jsdom 26 does not define.
 *
 * Download watchdog semantics: the fetch timeout bounds time to response
 * HEADERS only; the body download is guarded by a stall timer that re-arms
 * on every chunk. A slow-but-moving multi-megabyte snapshot must never be
 * aborted for total duration — only a stream that has gone silent is. That
 * distinction is what keeps a large-org cold start out of the endless
 * full-bootstrap retry loop.
 */
import { BootstrapFetcher } from '../BootstrapFetcher.js';
import { createTestContext } from '../../testing/mocks/MockSyncContext.js';
import { AbloConnectionError } from '@abloatai/transaction/errors';

const encoder = new TextEncoder();

/** A 200 response whose body arrives as `chunks`, `gapMs` apart. */
function chunkedResponse(chunks: string[], gapMs: number): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A 200 response whose body delivers one chunk and then goes silent forever. */
function stalledResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"full","lastSyncId":'));
      // Never closes, never enqueues again — a dead connection mid-body.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BootstrapFetcher download watchdog', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('assembles a body that arrives in many slow chunks (never aborts an active download)', async () => {
    createTestContext({});
    const payload = JSON.stringify({
      type: 'full',
      lastSyncId: 7,
      models: { SlideLayer: [{ id: 'a' }, { id: 'b' }] },
    });
    // 8 chunks, 20ms apart: total time (~160ms) far exceeds the 50ms stall
    // allowance, proving the guard measures chunk gaps, not total duration.
    const parts = payload.match(/.{1,20}/gs) ?? [];
    global.fetch = jest.fn(() => Promise.resolve(chunkedResponse(parts, 20)));

    const fetcher = new BootstrapFetcher({
      baseUrl: 'http://test/api',
      maxRetries: 1,
      stallTimeout: 50,
    });
    const data = await fetcher.fetchBootstrap();

    expect(data.type).toBe('full');
    expect(data.lastSyncId).toBe(7);
    expect(data.models?.SlideLayer).toHaveLength(2);
  });

  it('aborts a download whose stream goes silent and surfaces a retryable timeout', async () => {
    createTestContext({});
    global.fetch = jest.fn(() => Promise.resolve(stalledResponse()));

    const fetcher = new BootstrapFetcher({
      baseUrl: 'http://test/api',
      maxRetries: 1,
      retryDelay: 1,
      stallTimeout: 50,
    });

    await expect(fetcher.fetchBootstrap()).rejects.toMatchObject({
      code: 'bootstrap_fetch_timeout',
    });
    await expect(fetcher.fetchBootstrap()).rejects.toBeInstanceOf(AbloConnectionError);
  });
});
