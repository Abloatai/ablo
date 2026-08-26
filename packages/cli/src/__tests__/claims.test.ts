/**
 * What `ablo claims` guarantees, as opposed to what it prints.
 *
 * The lease is the only thing here worth testing: an agent that takes one and
 * walks away leaves a row locked until the TTL lapses, and every other writer
 * waits on a holder that no longer exists. So these assert the lifecycle — that
 * the lease is given back on every path out of `--`, including the failing and
 * the queued one — rather than that the verbs exist, which the registry already
 * proves and which a test could only pin to itself.
 *
 * The HTTP boundary is faked and the child process is real: the release is
 * observable as a `DELETE` on the wire, and a subprocess exit code is not worth
 * simulating when `process.execPath` will produce one.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { claims } from '../claims';
import { claimOnModelPath } from '@abloatai/transaction/claims/routes';

interface Call {
  readonly method: string;
  readonly path: string;
}

/** Responses keyed by what the CLI asks for, in the contract's own shapes. */
function claimRecord(model: string, id: string) {
  return {
    id: 'clm_1',
    actor: 'agt_1',
    participantKind: 'agent',
    expiresAt: Date.now() + 60_000,
    target: { model, id },
  };
}

function acquired(model: string, id: string) {
  return { id: 'clm_1', object: 'claim', status: 'active', claim: claimRecord(model, id) };
}

const QUEUED = { id: 'clm_1', object: 'claim', status: 'queued', position: 1 };
const RELEASED = { object: 'claim_release', released: true };

/**
 * A fetch that records what was asked and answers from a queue of replies, so a
 * test can say "the second poll grants it" without reaching into the module.
 */
function fakeFetch(reply: (call: Call, nth: number) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = jest.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname };
    calls.push(call);
    const { status, body } = reply(call, calls.length);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl, calls };
}

const NODE = process.execPath;

describe('ablo claims', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.ABLO_API_KEY;
  const originalUrl = process.env.ABLO_API_URL;
  let log: ReturnType<typeof jest.spyOn>;
  let err: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.ABLO_API_KEY = 'ak_claims_test';
    process.env.ABLO_API_URL = 'https://engine.example';
  });

  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    global.fetch = originalFetch;
    // `claims` reports a child's status through the runner's own exit code;
    // leaving it set would fail the suite that observed it.
    process.exitCode = undefined;
    if (originalKey === undefined) delete process.env.ABLO_API_KEY;
    else process.env.ABLO_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.ABLO_API_URL;
    else process.env.ABLO_API_URL = originalUrl;
  });

  it('gives the lease back when the wrapped command succeeds', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.method === 'DELETE'
        ? { status: 200, body: RELEASED }
        : { status: 201, body: acquired('order', 'ord_1') },
    );
    global.fetch = impl;

    await claims(['acquire', 'order', 'ord_1', '--', NODE, '-e', '']);

    expect(calls.map((c) => c.method)).toEqual(['POST', 'DELETE']);
    expect(calls[1]?.path).toBe(`/api${claimOnModelPath({ model: 'order', id: 'ord_1' })}`);
    expect(process.exitCode).toBe(0);
  });

  it('gives the lease back when the wrapped command fails, and reports its code', async () => {
    // The path that matters most: a command that throws must not strand the row.
    const { impl, calls } = fakeFetch((call) =>
      call.method === 'DELETE'
        ? { status: 200, body: RELEASED }
        : { status: 201, body: acquired('order', 'ord_1') },
    );
    global.fetch = impl;

    await claims(['acquire', 'order', 'ord_1', '--', NODE, '-e', 'process.exit(3)']);

    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(process.exitCode).toBe(3);
  });

  it('waits out the line before running the command, then releases', async () => {
    const seen: string[] = [];
    const { impl, calls } = fakeFetch((call, nth) => {
      seen.push(`${call.method} ${call.path}`);
      if (call.method === 'DELETE') return { status: 200, body: RELEASED };
      if (call.method === 'GET') {
        // The first poll still finds it queued; the second grants it.
        return nth < 3
          ? { status: 200, body: { id: 'clm_1', object: 'claim', status: 'queued', position: 0 } }
          : { status: 200, body: { id: 'clm_1', object: 'claim', status: 'active' } };
      }
      return { status: 202, body: QUEUED };
    });
    global.fetch = impl;

    await claims(['acquire', 'order', 'ord_1', '--queue', '--ttl', '4s', '--', NODE, '-e', '']);

    // Queued, polled until granted, then released — and the release is last,
    // which is what proves the command ran inside the lease and not beside it.
    expect(calls[0]?.method).toBe('POST');
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThanOrEqual(2);
    expect(calls[calls.length - 1]?.method).toBe('DELETE');
    expect(process.exitCode).toBe(0);
  }, 20_000);

  it('refuses to run the command when the wait ends without the lease', async () => {
    // A claim that expired while queued must raise. Running the command anyway
    // would be the silent success this whole surface exists to prevent.
    const { impl, calls } = fakeFetch((call) => {
      if (call.method === 'DELETE') return { status: 200, body: RELEASED };
      if (call.method === 'GET')
        return { status: 200, body: { id: 'clm_1', object: 'claim', status: 'expired' } };
      return { status: 202, body: QUEUED };
    });
    global.fetch = impl;

    await expect(
      claims(['acquire', 'order', 'ord_1', '--queue', '--ttl', '4s', '--', NODE, '-e', '']),
    ).rejects.toThrow(/without the lease/);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  }, 20_000);

  it('keeps a row id containing a slash on the claim route', async () => {
    // Unencoded, `a/b` addresses a different route entirely and the claim is
    // silently taken on nothing.
    const { impl, calls } = fakeFetch(() => ({ status: 201, body: acquired('order', 'a/b') }));
    global.fetch = impl;

    await claims(['acquire', 'order', 'a/b']);

    expect(calls[0]?.path).toBe('/api/v1/models/order/a%2Fb/claim');
  });
});
