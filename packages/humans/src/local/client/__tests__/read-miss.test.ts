/** @jest-environment node */

/**
 * Missing reads return absent data on both transports.
 * A claim on a missing row still fails because there is nothing to hold.
 */
import { createHttpTransport } from '@abloatai/transaction/transport/http';
import { AbloNotFoundError } from '@abloatai/transaction/errors';
import {
  claimAcquiredResponse,
  modelClaim,
  modelReadResponse,
} from '@abloatai/transaction/testing/fixtures/httpResponses';

type Json = Record<string, unknown>;

function resp(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (url: string, method: string) => Response;
function client(handler: Handler) {
  return createHttpTransport({
    apiKey: 'sk_test_unit',
    baseURL: 'https://api.test',
    transport: 'http',
    fetch: (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return Promise.resolve(handler(href, (init?.method ?? 'GET').toUpperCase()));
    },
    dangerouslyAllowBrowser: true,
  });
}

describe('read — missing row is data-absence, not an error', () => {
  it('resolves with data: undefined for a missing row (no throw)', async () => {
    const docs = client(() =>
      resp(200, modelReadResponse({ model: 'documents', id: 'nope', data: null })),
    ).model('documents');
    const read = await docs.read({ id: 'nope' });
    expect(read.data).toBeUndefined();
    expect(read.claims).toEqual([]);
  });

  it('returns the row when present', async () => {
    const docs = client((u) =>
      u.includes('/documents/doc-main')
        ? resp(
            200,
            modelReadResponse({
              model: 'documents',
              id: 'doc-main',
              data: { id: 'doc-main', title: 'Hi' },
              stamp: 9,
            }),
          )
        : resp(200, modelReadResponse({ model: 'documents', id: 'other', data: null })),
    ).model('documents');
    const read = await docs.read({ id: 'doc-main' });
    expect(read.data).toEqual({ id: 'doc-main', title: 'Hi' });
    expect(read.stamp).toBe(9);
  });

  it('still throws when claiming a row that does not exist', async () => {
    const docs = client((u, method) => {
      if (method === 'POST' && u.includes('/claim'))
        return resp(
          201,
          claimAcquiredResponse(
            modelClaim({ id: 'int_unit', model: 'documents', entityId: 'ghost' }),
          ),
        );
      // the post-claim read misses
      return resp(200, modelReadResponse({ model: 'documents', id: 'ghost', data: null }));
    }).model('documents');
    await expect(docs.claim({ id: 'ghost', description: 'edit' })).rejects.toBeInstanceOf(AbloNotFoundError);
  });
});
