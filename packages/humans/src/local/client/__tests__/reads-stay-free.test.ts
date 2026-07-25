/**
 * Reads are never blocked by a claim — the asymmetry at the heart of the
 * coordination model (coordination.md: "a claim serializes WRITERS, not
 * readers"). A regression that started gating reads by default would
 * otherwise pass silently, since every other coordination test exercises
 * writes.
 *
 * Against a fake fetch where an claim is ALWAYS held on Task/t1:
 *   - retrieve() resolves with the row by default (free);
 *   - retrieve({ ifClaimed: 'fail' }) DOES throw — proving the held claim is
 *     genuinely detected (the free read above isn't a false pass) and that
 *     gating reads is opt-in (developer's choice), not the default;
 *   - update({ ifClaimed: 'fail' }) throws on the same claimed row — the write
 *     side of the asymmetry.
 */

import { createHttpTransport } from '@ablo/transaction/transport/httpTransport';
import { AbloClaimedError } from '@ablo/transaction/errors';
import {
  claimListResponse,
  modelClaim,
  modelReadResponse,
} from '@ablo/transaction/testing/fixtures/httpResponses';

const HELD_INTENT = modelClaim({
  id: 'int_held',
  model: 'Task',
  entityId: 't1',
  actor: 'agent:other',
  participantKind: 'agent',
  description: 'editing',
});

/** A fetch that always reports Task/t1 as claimed, and serves its row. */
function fakeFetch(): typeof fetch {
  const json = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    }) as unknown as Response;

  return async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/v1/claims')) {
      return json(claimListResponse({ claims: [HELD_INTENT] }));
    }
    if (url.includes('/v1/models/')) {
      return json(
        modelReadResponse({ model: 'Task', id: 't1', data: { id: 't1', title: 'hello' } }),
      );
    }
    if (url.includes('/v1/commits')) {
      // A write would only reach here if the claimed policy let it through.
      return json({ id: 'commit_1', status: 'confirmed', lastSyncId: 1 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function makeClient() {
  return createHttpTransport({
    apiKey: 'sk_test',
    baseURL: 'https://api.test',
    fetch: fakeFetch(),
    // The package's Jest env is jsdom (window present) → the secret-key
    // browser guard would trip; this is a Node-side unit test, not a bundle.
    dangerouslyAllowBrowser: true,
  });
}

describe('reads stay free under a claim', () => {
  it('retrieve resolves by default even when the row is claimed', async () => {
    const client = makeClient();
    const read = await client.model('Task').retrieve({ id: 't1' });
    expect(read.data).toMatchObject({ id: 't1', title: 'hello' });
  });

  it('retrieve gates only when the caller opts in (ifClaimed: fail)', async () => {
    const client = makeClient();
    await expect(
      client.model('Task').retrieve({ id: 't1', ifClaimed: 'fail' }),
    ).rejects.toBeInstanceOf(AbloClaimedError);
  });

  it('writes to the same claimed row gate (ifClaimed: fail)', async () => {
    const client = makeClient();
    await expect(
      client.model('Task').update({
        id: 't1',
        data: { title: 'x' },
        ifClaimed: 'fail',
      }),
    ).rejects.toBeInstanceOf(AbloClaimedError);
  });
});
