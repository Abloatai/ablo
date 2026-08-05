/**
 * HTTP `create` returns the row, not a bare receipt — matching the WebSocket
 * client (whose `create` already returns `T`). The returned row is the
 * authoritative read-back (framework defaults included), and for an idempotent
 * re-create of an existing id it is the EXISTING row, not the caller's input.
 */
import { createHttpTransport } from '@abloatai/transaction/transport/httpTransport';
import {
  COMMIT_FIXTURE_TIMES,
  EFFECTIVE_AUTHORITY_FIXTURE,
  modelReadResponse,
} from '@abloatai/transaction/testing/fixtures/httpResponses';

type Json = Record<string, unknown>;

function resp(status: number, body: Json): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

type Handler = (url: string, method: string, init?: RequestInit) => Response;
function client(handler: Handler) {
  return createHttpTransport({
    apiKey: 'sk_test_unit',
    baseURL: 'https://api.test',
    transport: 'http',
    fetch: async (url: string | URL | Request, init?: RequestInit) =>
      handler(
        typeof url === 'string' ? url : url.toString(),
        (init?.method ?? 'GET').toUpperCase(),
        init,
      ),
    dangerouslyAllowBrowser: true,
  });
}

function confirmed(init: RequestInit | undefined, serverTxId: string): Json {
  const headers = init?.headers as Record<string, string> | undefined;
  return {
    object: 'commit_receipt',
    clientTxId: headers?.['Idempotency-Key'],
    serverTxId,
    ...COMMIT_FIXTURE_TIMES,
    success: true,
    authority: EFFECTIVE_AUTHORITY_FIXTURE,
    status: 'confirmed',
    lastSyncId: 1,
    ops: 1,
  };
}

describe('create returns the row', () => {
  it('resolves with the confirmed server row (read-back), not a receipt', async () => {
    const stored = { id: 'doc-main', title: 'Seed', createdAt: '2026-01-01T00:00:00Z' };
    const docs = client((u, method, init) => {
      if (method === 'POST' && u.endsWith('/v1/models/documents'))
        return resp(200, confirmed(init, 'tx_1'));
      if (method === 'GET' && u.includes('/v1/models/documents/doc-main'))
        return resp(
          200,
          modelReadResponse({ model: 'documents', id: 'doc-main', data: stored, stamp: 3 }),
        );
      return resp(200, modelReadResponse({ model: 'documents', id: 'doc-main', data: null }));
    }).model('documents');

    const row = await docs.create({ id: 'doc-main', data: { title: 'Seed' } });
    // The ROW (with server-applied createdAt), not { status, lastSyncId, ... }.
    expect(row).toEqual(stored);
  });

  it('returns the EXISTING row on an idempotent re-create (server keeps original)', async () => {
    const existing = { id: 'doc-main', title: 'Original', content: 'real' };
    const docs = client((u, method, init) => {
      // Idempotent no-op create (engine ON CONFLICT DO NOTHING) still confirms…
      if (method === 'POST') return resp(200, confirmed(init, 'tx_existing'));
      // …and the read-back returns the ORIGINAL row, not the caller's blank seed.
      if (method === 'GET')
        return resp(
          200,
          modelReadResponse({ model: 'documents', id: 'doc-main', data: existing, stamp: 9 }),
        );
      return resp(200, modelReadResponse({ model: 'documents', id: 'doc-main', data: null }));
    }).model('documents');

    const row = await docs.create({ id: 'doc-main', data: { title: 'Blank', content: '' } });
    expect(row).toEqual(existing);
  });
});
