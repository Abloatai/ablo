/**
 * HTTP transport ↔ observability WIRING.
 *
 * The `ClaimLog` SINK is unit-tested in coordination/__tests__/trace.test.ts
 * (it calls captureClaim/captureConflict directly). That left the SOURCE — the
 * code in `createHttpTransport` that is supposed to CALL the sink — untested,
 * which is exactly how the HTTP transport shipped emitting NOTHING (a ClaimLog
 * handed to a headless agent eval stayed empty). These tests drive the real
 * client wiring over the injectable `fetch` seam (the network boundary is the
 * only thing stubbed — no fabricated domain logic), asserting the two seams the
 * WS transport already had: claim acquired + coordination-conflict rejection.
 */
import { createHttpTransport } from '@abloatai/transaction/transport/http';
import { ClaimLog } from '../../coordination/ClaimLog.js';
import {
  claimAcquiredResponse,
  claimListResponse,
  modelClaim,
  modelReadResponse,
} from '@abloatai/transaction/testing/fixtures/httpResponses';

type Json = Record<string, unknown>;

function resp(status: number, body: Json): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? 'Conflict' : status === 400 ? 'Bad Request' : 'OK',
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

type Handler = (url: string, method: string) => Response;
function makeFetch(handler: Handler): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    return handler(u, method);
  };
}

function makeClient(log: ClaimLog, handler: Handler) {
  return createHttpTransport({
    apiKey: 'sk_test_unit',
    baseURL: 'https://api.test',
    transport: 'http',
    observability: log,
    fetch: makeFetch(handler),
    dangerouslyAllowBrowser: true, // jest runs jsdom; the sk_ browser guard is irrelevant to this unit
  });
}

describe('HTTP transport observability wiring', () => {
  it('emits captureClaim(acquired) — naming the row — when a claim is taken', async () => {
    const log = new ClaimLog();
    const docs = makeClient(log, (u, method) => {
      if (method === 'POST' && u.includes('/claim'))
        return resp(
          201,
          claimAcquiredResponse(
            modelClaim({ id: 'int_unit', model: 'documents', entityId: 'doc-main' }),
          ),
        );
      if (method === 'GET' && u.includes('/v1/models/documents/doc-main'))
        return resp(
          200,
          modelReadResponse({
            model: 'documents',
            id: 'doc-main',
            data: { id: 'doc-main', content: { ok: true } },
            stamp: 5,
          }),
        );
      return resp(200, claimListResponse());
    }).model('documents');

    await docs.claim({ id: 'doc-main', description: 'edit' });

    const acquired = log.entries.filter((e) => e.claim?.phase === 'acquired');
    expect(acquired).toHaveLength(1);
    expect(acquired[0]?.line).toContain('documents/doc-main');
  });

  it('emits captureConflict — a collision naming the row — when a write is rejected stale', async () => {
    const log = new ClaimLog();
    const docs = makeClient(log, (_u, method) => {
      if (method === 'PATCH')
        return resp(409, {
          type: 'AbloStaleContextError',
          code: 'stale_context',
          message: 'received deltas since readAt',
          conflicts: [{ model: 'documents', id: 'doc-main', observedSyncId: 7 }],
        });
      return resp(200, claimListResponse());
    }).model('documents');

    await expect(
      docs.update({ id: 'doc-main', data: { content: {} }, readAt: 1 }),
    ).rejects.toMatchObject({ code: 'stale_context' });

    const collisions = log.collisions();
    expect(collisions).toHaveLength(1);
    const collision = collisions[0];
    if (!collision) throw new Error('expected a recorded collision');
    expect(collision.conflict).toBeDefined();
    expect(collision.line).toContain('documents/doc-main');
  });

  it('does NOT record a collision for a non-coordination rejection (validation error)', async () => {
    const log = new ClaimLog();
    const docs = makeClient(log, (_u, method) => {
      if (method === 'PATCH')
        return resp(400, { type: 'AbloValidationError', code: 'validation_error', message: 'bad input' });
      return resp(200, claimListResponse());
    }).model('documents');

    await expect(docs.update({ id: 'doc-main', data: { content: {} } })).rejects.toBeDefined();
    expect(log.collisions()).toHaveLength(0);
  });
});
