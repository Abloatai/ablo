/**
 * The deregistration operation: outcome typing (removed vs nothing-to-remove),
 * the sk_-remedy on a permission refusal, and the replication-slot warning the
 * server attaches when it stopped reading but could not release the slot —
 * the field the old hand-cast decoder silently dropped.
 */

import { AbloPermissionError, AbloServerError } from '@abloatai/transaction/errors';
import { deregisterDataSource } from '../disconnect';

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: (): Promise<unknown> => Promise.resolve(body),
});

describe('deregisterDataSource', () => {
  it('DELETEs the plane datasource and returns the parsed response', async () => {
    const seen: { url?: string; method?: string; auth?: string } = {};
    const outcome = await deregisterDataSource({
      apiKey: 'sk_test_k',
      baseUrl: 'https://api.abloatai.com',
      fetchImpl: (url, init) => {
        seen.url = url;
        seen.method = init.method;
        seen.auth = init.headers.authorization;
        return Promise.resolve(
          jsonResponse(200, {
            object: 'datasource_disconnected',
            environment: 'test',
            cleared: { direct: true, endpoints: 2 },
          })
        );
      },
    });
    expect(seen).toEqual({
      url: 'https://api.abloatai.com/api/v1/datasources',
      method: 'DELETE',
      auth: 'Bearer sk_test_k',
    });
    expect(outcome).toEqual({
      removed: true,
      response: {
        object: 'datasource_disconnected',
        environment: 'test',
        cleared: { direct: true, endpoints: 2 },
      },
    });
  });

  it('carries the replication-slot warning through — a reader must see it', async () => {
    const outcome = await deregisterDataSource({
      apiKey: 'sk_test_k',
      baseUrl: 'https://x.test',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(200, {
            object: 'datasource_disconnected',
            cleared: { direct: true, endpoints: 0 },
            replication_slot: {
              slot: 'ablo_slot_org1',
              released: false,
              remove_with: "SELECT pg_drop_replication_slot('ablo_slot_org1');",
              warning:
                'This slot is still on your database and still holding your write-ahead log.',
            },
          })
        ),
    });
    if (!outcome.removed) throw new Error('expected a removal');
    expect(outcome.response.replication_slot).toMatchObject({
      slot: 'ablo_slot_org1',
      released: false,
      remove_with: "SELECT pg_drop_replication_slot('ablo_slot_org1');",
    });
  });

  it('reads "nothing registered" as a no-op outcome, not a failure', async () => {
    const outcome = await deregisterDataSource({
      apiKey: 'sk_test_k',
      baseUrl: 'https://x.test',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(404, { code: 'entity_not_found', message: 'no data source registered' })
        ),
    });
    expect(outcome).toEqual({ removed: false });
  });

  it('re-raises a permission refusal with the key-kind remedy attached', async () => {
    const attempt = deregisterDataSource({
      apiKey: 'pk_live_wrong',
      baseUrl: 'https://x.test',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse(403, { code: 'forbidden', message: 'forbidden: requires a secret API key' })
        ),
    });
    await expect(attempt).rejects.toThrow(AbloPermissionError);
    await expect(attempt).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('secret key (sk_'),
    });
  });

  it('refuses a 2xx that is not the disconnect response', async () => {
    // The old decoder cast whatever came back and reported success from
    // `undefined` fields. A body without `cleared` is not this response.
    const attempt = deregisterDataSource({
      apiKey: 'sk_test_k',
      baseUrl: 'https://x.test',
      fetchImpl: () => Promise.resolve(jsonResponse(200, { unrelated: true })),
    });
    await expect(attempt).rejects.toThrow(AbloServerError);
    await expect(attempt).rejects.toMatchObject({ code: 'response_unrecognized' });
  });
});
