/**
 * HTTP transport request deadline — a stateless request must never hang
 * forever on a black-holed server (T1.12).
 *
 * `requestJson` arms a per-request abort deadline (`timeoutMs`, default 30s)
 * and surfaces it as a typed, RETRYABLE connection error carrying the
 * registered `wait_for_timeout` code. A caller-initiated abort is NOT
 * mislabeled as a timeout — it propagates unchanged.
 */
import { createHttpTransport } from '@abloatai/transaction/transport/http';
import { AbloConnectionError, isRetryableCode } from '@abloatai/transaction/errors';
import { modelReadResponse } from '@abloatai/transaction/testing/fixtures/httpResponses';

/** A fetch that never responds but honors its AbortSignal (a black hole). */
const blackHoleFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // never settles — the deadline must fire
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener(
      'abort',
      () => { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); },
      { once: true },
    );
  })) as typeof fetch;

function client(timeoutMs: number | undefined) {
  return createHttpTransport({
    apiKey: 'sk_test_unit',
    baseURL: 'https://api.test',
    transport: 'http',
    fetch: blackHoleFetch,
    dangerouslyAllowBrowser: true,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

describe('HTTP transport request deadline', () => {
  it('aborts a black-holed request and throws a typed retryable timeout error', async () => {
    const docs = client(25).model('documents');

    let caught: unknown;
    try {
      await docs.read({ id: 'doc-1' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AbloConnectionError);
    const err = caught as AbloConnectionError;
    expect(err.code).toBe('wait_for_timeout');
    expect(isRetryableCode(err.code!)).toBe(true);
    expect(err.message).toContain('25ms');
  });

  it('applies the deadline to writes too (POST /v1/models)', async () => {
    const docs = client(25).model('documents');
    await expect(
      docs.create({ id: 'doc-2', data: { title: 'x' } }),
    ).rejects.toMatchObject({ code: 'wait_for_timeout' });
  });

  it('does not misreport a slow-but-successful request', async () => {
    const okFetch = ((_url: string | URL | Request) =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () =>
          JSON.stringify(
            modelReadResponse({
              model: 'documents',
              id: 'doc-3',
              data: { id: 'doc-3' },
              stamp: 1,
            }),
          ),
        headers: { get: () => null },
      } as unknown as Response)) as typeof fetch;

    const docs = createHttpTransport({
      apiKey: 'sk_test_unit',
      baseURL: 'https://api.test',
      transport: 'http',
      fetch: okFetch,
      dangerouslyAllowBrowser: true,
      timeoutMs: 25,
    }).model('documents');

    const read = await docs.read({ id: 'doc-3' });
    expect(read.data).toEqual({ id: 'doc-3' });
  });
});
