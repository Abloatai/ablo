/**
 * The one HTTP boundary: URL building (the `/api` mount), auth headers, dial
 * failures as typed connection errors, envelope decoding through
 * `translateHttpError`, and the success-shape parse. Every command rides this,
 * so what is pinned here holds for connect, deregister, validate, and locate
 * alike.
 */

import { z } from 'zod';
import {
  AbloConnectionError,
  AbloError,
  AbloServerError,
  AbloValidationError,
} from '@abloatai/transaction/errors';
import { requestControlPlane, tryControlPlane, type ControlPlaneFetch } from '../controlPlane';

const okSchema = z.object({ fine: z.boolean() });

/** A plain-object response — the injectable seam reads ok/status/json and an
 *  optional headers.get, so tests never depend on the runtime's Response global. */
const jsonResponse = (status: number, body: unknown, requestId?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  ...(requestId !== undefined
    ? { headers: { get: (name: string) => (name === 'x-request-id' ? requestId : null) } }
    : {}),
  json: (): Promise<unknown> => Promise.resolve(body),
});

describe('requestControlPlane — URL and headers', () => {
  it('mounts every route under /api and tolerates a trailing slash on the base', async () => {
    // The server mounts all routes under `/api`; a bare `/v1/datasources`
    // matches nothing and surfaces as the global "Not found".
    const urls: string[] = [];
    const fetchImpl: ControlPlaneFetch = (url) => {
      urls.push(url);
      return Promise.resolve(jsonResponse(200, { fine: true }));
    };
    await requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://api.abloatai.com',
      responseSchema: okSchema,
      fetchImpl,
    });
    await requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://api.abloatai.com/',
      responseSchema: okSchema,
      fetchImpl,
    });
    expect(urls).toEqual([
      'https://api.abloatai.com/api/v1/datasources',
      'https://api.abloatai.com/api/v1/datasources',
    ]);
  });

  it('sends the bearer key, and content-type only when there is a body', async () => {
    const seen: Array<{ headers: Record<string, string>; body?: string }> = [];
    const fetchImpl: ControlPlaneFetch = (_url, init) => {
      seen.push({ headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
      return Promise.resolve(jsonResponse(200, { fine: true }));
    };
    await requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://x.test',
      apiKey: 'sk_test_k',
      responseSchema: okSchema,
      fetchImpl,
    });
    await requestControlPlane({
      path: '/v1/datasources/validate',
      method: 'POST',
      baseUrl: 'https://x.test',
      apiKey: 'sk_test_k',
      body: { connectionString: 'postgres://u:p@h/db' },
      responseSchema: okSchema,
      fetchImpl,
    });
    expect(seen[0]).toEqual({ headers: { authorization: 'Bearer sk_test_k' } });
    expect(seen[1]).toEqual({
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk_test_k' },
      body: JSON.stringify({ connectionString: 'postgres://u:p@h/db' }),
    });
  });
});

describe('requestControlPlane — failure typing', () => {
  it('classifies a dial failure as api_unreachable, naming the target', async () => {
    const attempt = requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://api.abloatai.com',
      responseSchema: okSchema,
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.abloatai.com')),
    });
    await expect(attempt).rejects.toThrow(AbloConnectionError);
    await expect(attempt).rejects.toMatchObject({
      code: 'api_unreachable',
      details: { target: 'https://api.abloatai.com' },
    });
  });

  it('decodes a flat error envelope into the typed error, with the request id', async () => {
    const attempt = requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://x.test',
      responseSchema: okSchema,
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(
            400,
            { type: 'AbloValidationError', code: 'invalid_body', message: 'endpoint must use https' },
            'req_123'
          )
        ),
    });
    await expect(attempt).rejects.toThrow(AbloValidationError);
    await expect(attempt).rejects.toMatchObject({
      code: 'invalid_body',
      httpStatus: 400,
      requestId: 'req_123',
      message: 'endpoint must use https',
    });
  });

  it('decodes a nested error envelope (older/wrapped deployments)', async () => {
    const attempt = requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://x.test',
      responseSchema: okSchema,
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(404, {
            error: { code: 'no_data_source_registered', message: 'nothing connected here' },
          })
        ),
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'no_data_source_registered',
      httpStatus: 404,
    });
  });

  it("headlines the server's message and keeps the driver's reason as detail", async () => {
    // The register/validate rejections carry both: `message` is the sentence
    // the server wrote for a person, `reason` the raw driver text beside it.
    // The message must win the headline — the reason used to clobber it, which
    // showed "getaddrinfo ENOTFOUND …" where the remedy should have been.
    const attempt = requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://x.test',
      responseSchema: okSchema,
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(400, {
            code: 'database_unreachable',
            message: 'Ablo could not reach this database. Use a publicly reachable host.',
            reason: 'getaddrinfo ENOTFOUND db.internal',
          })
        ),
    });
    await expect(attempt).rejects.toMatchObject({
      code: 'database_unreachable',
      message: 'Ablo could not reach this database. Use a publicly reachable host.',
      details: { reason: 'getaddrinfo ENOTFOUND db.internal' },
    });
  });

  it('refuses a 2xx whose body is not the route response', async () => {
    const attempt = requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://x.test',
      responseSchema: okSchema,
      fetchImpl: () => Promise.resolve(jsonResponse(200, '<html>proxy login page</html>')),
    });
    await expect(attempt).rejects.toThrow(AbloServerError);
    await expect(attempt).rejects.toMatchObject({ code: 'response_unrecognized' });
  });

  it('parses a 2xx against the wire schema and returns the typed value', async () => {
    const value = await requestControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://x.test',
      responseSchema: okSchema,
      fetchImpl: () => Promise.resolve(jsonResponse(200, { fine: true })),
    });
    expect(value).toEqual({ fine: true });
  });
});

describe('tryControlPlane', () => {
  it('resolves failures to a typed result instead of throwing', async () => {
    const result = await tryControlPlane({
      path: '/v1/datasources',
      baseUrl: 'https://x.test',
      responseSchema: okSchema,
      fetchImpl: () => Promise.reject(new Error('offline')),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failure result');
    expect(result.error).toBeInstanceOf(AbloError);
    expect(result.error.code).toBe('api_unreachable');
  });
});
