/** @jest-environment node */

import { createHttpTransport } from '@abloatai/transaction/transport/httpTransport';
import { idempotencyKeySchema } from '@abloatai/transaction/transactions/settlement/idempotencyKey';
import type {
  DurableWriteStore,
  PendingWrite,
} from '../../transactions/mutations/durableWriteStore.js';
import {
  durableHttpCommitEnvelopeSchema,
  HTTP_COMMIT_REPLAY_WINDOW_MS,
  httpCommitEnvelopeRecordId,
  type DurableHttpCommitEnvelope,
} from '@abloatai/transaction/transactions/settlement/httpCommitEnvelope';
import {
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
} from '@abloatai/transaction/wire/protocolVersion';
import { modelReadResponse } from '@abloatai/transaction/testing/fixtures/httpResponses';

const OUTBOX_SCOPE = {
  organizationId: 'org_test',
  participantId: 'agent_test',
  namespace: 'http-tests',
} as const;

type LegacyHttpCommitEnvelope = Omit<DurableHttpCommitEnvelope, 'protocolVersion'>;
type StoredWrite = PendingWrite | LegacyHttpCommitEnvelope;

function storedProtocolVersion(record: StoredWrite): number | undefined {
  if (record.type !== 'http_commit_envelope') return undefined;
  return 'protocolVersion' in record ? record.protocolVersion : 1;
}

class MemoryCommitOutbox implements DurableWriteStore {
  readonly records = new Map<string, StoredWrite>();
  readonly sealedRecords: PendingWrite[] = [];
  beforeSeal?: () => Promise<void>;
  failRemove = false;

  async seal(record: PendingWrite): Promise<void> {
    await this.beforeSeal?.();
    this.sealedRecords.push(structuredClone(record));
    const existing = this.records.get(record.id);
    if (
      existing &&
      JSON.stringify({
        type: existing.type,
        protocolVersion: storedProtocolVersion(existing),
        request: 'request' in existing ? existing.request : existing,
      }) !==
        JSON.stringify({
          type: record.type,
          protocolVersion:
            record.type === 'http_commit_envelope'
              ? record.protocolVersion
              : undefined,
          request: 'request' in record ? record.request : record,
        })
    ) {
      throw new Error('idempotency conflict');
    }
    if (!existing) {
      this.records.set(record.id, structuredClone(record));
    } else if (
      existing.type === 'http_commit_envelope' &&
      record.type === 'http_commit_envelope' &&
      existing.acceptedAt === undefined &&
      record.acceptedAt !== undefined
    ) {
      this.records.set(record.id, structuredClone(record));
    }
  }

  list(): Promise<readonly unknown[]> {
    return Promise.resolve(
      [...this.records.values()].map((record) => structuredClone(record)),
    );
  }

  remove(id: string): Promise<void> {
    if (this.failRemove) return Promise.reject(new Error('storage unavailable'));
    this.records.delete(id);
    return Promise.resolve();
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
  });
}

function commitResponse(init: RequestInit | undefined, lastSyncId = 1): Response {
  const clientTxId = new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
  return response({
    object: 'commit_receipt',
    clientTxId,
    serverTxId: `server-${clientTxId}`,
    success: true,
    status: 'confirmed',
    lastSyncId,
    ops: 1,
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not met');
}

async function leaveAmbiguousDelete(
  outbox: MemoryCommitOutbox,
  idempotencyKey: string,
  id: string,
): Promise<DurableHttpCommitEnvelope> {
  const client = createHttpTransport({
    apiKey: 'sk_test_outbox',
    baseURL: 'https://api.example.test',
    commitOutbox: outbox,
    commitOutboxScope: OUTBOX_SCOPE,
    fetch: () => Promise.reject(new Error('connection reset after send')),
  });
  await expect(client.commits.create({
    idempotencyKey,
    operations: [{ action: 'delete', model: 'tasks', id }],
  })).rejects.toThrow();

  const record = [...outbox.records.values()][0];
  const parsed = durableHttpCommitEnvelopeSchema.safeParse(record);
  if (!parsed.success) {
    throw new Error('missing HTTP outbox record');
  }
  return parsed.data;
}

async function replayedProtocolVersion(
  outbox: MemoryCommitOutbox,
): Promise<string | undefined> {
  let version: string | undefined;
  const client = createHttpTransport({
    apiKey: 'sk_test_outbox',
    baseURL: 'https://api.example.test',
    commitOutbox: outbox,
    commitOutboxScope: OUTBOX_SCOPE,
    fetch: (_input, init) => {
      version = new Headers(init?.headers).get(PROTOCOL_VERSION_HEADER) ?? undefined;
      return Promise.resolve(commitResponse(init));
    },
  });
  await client.ready();
  return version;
}

describe('stateless HTTP commit outbox', () => {
  it('awaits durable sealing before the first network call', async () => {
    const outbox = new MemoryCommitOutbox();
    let releaseSeal!: () => void;
    let sealStarted = false;
    const gate = new Promise<void>((resolve) => { releaseSeal = resolve; });
    outbox.beforeSeal = () => {
      sealStarted = true;
      return gate;
    };
    const fetchImpl = jest.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(commitResponse(init, 4)),
    );
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      fetch: fetchImpl,
      durableWrites: { store: outbox, namespace: OUTBOX_SCOPE.namespace },
      commitOutboxScope: OUTBOX_SCOPE,
    });

    const pending = client.commits.create({
      idempotencyKey: 'http-key-1',
      operations: [{ action: 'update', model: 'tasks', id: 'task-1', data: { title: 'safe' } }],
    });
    await waitFor(() => sealStarted);
    expect(fetchImpl).not.toHaveBeenCalled();

    releaseSeal();
    await expect(pending).resolves.toMatchObject({ status: 'confirmed', lastSyncId: 4 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('missing fetch call');
    const [request, init] = call;
    const requestUrl =
      typeof request === 'string'
        ? request
        : request instanceof URL
          ? request.href
          : request.url;
    expect(requestUrl).toContain('/api/v1/commits');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(
      'http-key-1',
    );
    if (typeof init?.body !== 'string') throw new Error('missing request body');
    const posted: unknown = JSON.parse(init.body);
    if (typeof posted !== 'object' || posted === null || Array.isArray(posted)) {
      throw new Error('expected a JSON object request body');
    }
    expect(Object.keys(posted)).toEqual(['operations']);
    expect(outbox.sealedRecords).toHaveLength(1);
    expect(outbox.sealedRecords[0]).toMatchObject({
      type: 'http_commit_envelope',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(outbox.records.size).toBe(0);
  });

  it('returns a queued receipt without deleting its durable envelope', async () => {
    const outbox = new MemoryCommitOutbox();
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: 'queued',
          correlationId: 'echo_v1_queued',
          lastSyncId: 0,
          ops: 1,
        }));
      },
    });

    await expect(client.commits.create({
      idempotencyKey: 'http-forwarded-queued',
      operations: [
        { action: 'update', model: 'tasks', id: 'task-1', data: { title: 'safe' } },
      ],
      wait: 'queued',
    })).resolves.toMatchObject({
      status: 'queued',
      lastSyncId: 0,
    });
    expect(outbox.records.size).toBe(1);
  });

  it('polls the identical sealed request until wait confirmed is promoted', async () => {
    const outbox = new MemoryCommitOutbox();
    const attempts: { key: string | null; body: string }[] = [];
    let responseNumber = 0;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        responseNumber += 1;
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        attempts.push({
          key: clientTxId,
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: responseNumber < 3 ? 'queued' : 'confirmed',
          correlationId: 'echo_v1_deterministic',
          lastSyncId: responseNumber < 3 ? 0 : 42,
          ops: 1,
        }));
      },
    });
    const request = {
      idempotencyKey: 'http-forwarded-promote',
      operations: [
        { action: 'update' as const, model: 'tasks', id: 'task-1', data: { title: 'safe' } },
      ],
    };

    await expect(client.commits.create({
      ...request,
      wait: 'queued',
    })).resolves.toMatchObject({ status: 'queued' });
    expect(outbox.records.size).toBe(1);

    await expect(client.commits.create({
      ...request,
      wait: 'confirmed',
    })).resolves.toMatchObject({ status: 'confirmed', lastSyncId: 42 });
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((attempt) => attempt.key))).toEqual(
      new Set(['http-forwarded-promote']),
    );
    expect(new Set(attempts.map((attempt) => attempt.body)).size).toBe(1);
    expect(outbox.records.size).toBe(0);
  });

  it('throws replication lag on confirmed wait while retaining accepted intent', async () => {
    const outbox = new MemoryCommitOutbox();
    let promoted = false;
    let attempts = 0;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      timeoutMs: 10,
      fetch: (_input, init) => {
        attempts += 1;
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: promoted ? 'confirmed' : 'queued',
          correlationId: 'echo_v1_lagged',
          lastSyncId: promoted ? 77 : 0,
          ops: 1,
        }));
      },
    });
    const request = {
      idempotencyKey: 'http-forwarded-lag',
      operations: [
        { action: 'update' as const, model: 'tasks', id: 'task-1', data: { title: 'safe' } },
      ],
      wait: 'confirmed' as const,
    };

    await expect(client.commits.create(request)).rejects.toMatchObject({
      code: 'replication_lag_timeout',
      details: {
        clientTxId: 'http-forwarded-lag',
        correlationId: 'echo_v1_lagged',
        accepted: true,
        timeoutMs: 10,
      },
    });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(outbox.records.size).toBe(1);

    promoted = true;
    await expect(client.commits.create(request)).resolves.toMatchObject({
      status: 'confirmed',
      lastSyncId: 77,
    });
    expect(outbox.records.size).toBe(0);
  });

  it('retains queued envelopes when startup replay has no echo yet', async () => {
    const outbox = new MemoryCommitOutbox();
    const queuedReply = (_input: RequestInfo | URL, init?: RequestInit) => {
      const clientTxId =
        new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
      return Promise.resolve(response({
        object: 'commit_receipt',
        clientTxId,
        serverTxId: `server-${clientTxId}`,
        success: true,
        status: 'queued',
        correlationId: 'echo_v1_startup',
        lastSyncId: 0,
        ops: 1,
      }));
    };
    const first = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: queuedReply,
    });
    await first.commits.create({
      idempotencyKey: 'http-forwarded-startup',
      operations: [{ action: 'delete', model: 'tasks', id: 'task-1' }],
      wait: 'queued',
    });
    expect(outbox.records.size).toBe(1);

    const restarted = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: queuedReply,
    });
    await expect(restarted.ready()).resolves.toBeUndefined();
    expect(outbox.records.size).toBe(1);
  });

  it('does not report a retained queued envelope as flushed', async () => {
    const outbox = new MemoryCommitOutbox();
    let promoted = false;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      timeoutMs: 10,
      fetch: (_input, init) => {
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: promoted ? 'confirmed' : 'queued',
          correlationId: 'echo_v1_flush',
          lastSyncId: promoted ? 91 : 0,
          ops: 1,
        }));
      },
    });

    await client.commits.create({
      idempotencyKey: 'http-forwarded-flush',
      operations: [{ action: 'delete', model: 'tasks', id: 'task-1' }],
      wait: 'queued',
    });

    await expect(client.waitForFlush()).rejects.toMatchObject({
      code: 'replication_lag_timeout',
      details: {
        clientTxId: 'http-forwarded-flush',
        correlationId: 'echo_v1_flush',
        accepted: true,
      },
    });
    expect(outbox.records.size).toBe(1);

    promoted = true;
    await expect(client.waitForFlush()).resolves.toBeUndefined();
    expect(outbox.records.size).toBe(0);
  });

  it('applies queued-versus-confirmed durability to per-model HTTP writes', async () => {
    const outbox = new MemoryCommitOutbox();
    let responseNumber = 0;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        responseNumber += 1;
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: responseNumber < 3 ? 'queued' : 'confirmed',
          correlationId: 'echo_v1_model',
          lastSyncId: responseNumber < 3 ? 0 : 88,
          ops: 1,
        }));
      },
    });
    const update = {
      id: 'task-1',
      data: { title: 'source owned' },
      idempotencyKey: 'http-model-forwarded',
    };

    await expect(client.model('tasks').update({
      ...update,
      wait: 'queued',
    })).resolves.toMatchObject({ status: 'queued' });
    expect(outbox.records.size).toBe(1);
    await expect(client.model('tasks').update({
      ...update,
      wait: 'confirmed',
    })).resolves.toMatchObject({ status: 'confirmed', lastSyncId: 88 });
    expect(outbox.records.size).toBe(0);
  });

  it('rejects mixed canonical and deprecated store configuration', () => {
    const outbox = new MemoryCommitOutbox();
    expect(() =>
      createHttpTransport({
        apiKey: 'sk_test_outbox',
        baseURL: 'https://api.example.test',
        fetch: jest.fn(),
        durableWrites: { store: outbox },
        commitOutbox: outbox,
      }),
    ).toThrow('pass `durableWrites` or the deprecated `commitOutbox`, not both');
  });

  it('derives durable-write identity from auth and keeps only namespace configurable', async () => {
    const outbox = new MemoryCommitOutbox();
    const requestedPaths: string[] = [];
    const fetchImpl = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(rawUrl).pathname;
      requestedPaths.push(path);
      if (path.endsWith('/auth/identity')) {
        return Promise.resolve(response({
          participantKind: 'agent',
          participantId: OUTBOX_SCOPE.participantId,
          accountScope: OUTBOX_SCOPE.organizationId,
          projectId: null,
          environment: null,
          sandboxId: null,
          syncGroups: [],
          userMeta: {},
        }));
      }
      return Promise.resolve(commitResponse(init, 7));
    });
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      fetch: fetchImpl,
      durableWrites: { store: outbox, namespace: 'agent-worker' },
    });

    await client.commits.create({
      idempotencyKey: 'auth-scoped-write',
      operations: [{ action: 'delete', model: 'tasks', id: 'task-identity' }],
    });

    expect(requestedPaths.some((path) => path.endsWith('/auth/identity'))).toBe(true);
    expect(outbox.sealedRecords).toHaveLength(1);
    expect(outbox.sealedRecords[0]).toMatchObject({ type: 'http_commit_envelope' });
    expect(
      outbox.sealedRecords[0]?.type === 'http_commit_envelope'
        ? outbox.sealedRecords[0].scopeNamespace
        : '',
    ).toContain('agent-worker');
  });

  it('validates durable-write adapters at runtime with Zod', () => {
    expect(() =>
      createHttpTransport({
        apiKey: 'sk_test_outbox',
        baseURL: 'https://api.example.test',
        fetch: jest.fn(),
        durableWrites: { store: {} } as never,
      }),
    ).toThrow('store must implement seal(), list(), and remove()');
  });

  it('replays a crash-surviving request with the identical key and body', async () => {
    const outbox = new MemoryCommitOutbox();
    const firstAttempts: { key: string | null; body: string }[] = [];
    const first = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        firstAttempts.push({
          key: headers['Idempotency-Key'] ?? null,
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return Promise.reject(new Error('connection reset after send'));
      },
    });

    await expect(
      first.commits.create({
        idempotencyKey: 'http-key-crash',
        operations: [
          { action: 'update', model: 'tasks', id: 'task-a', data: { rank: 1 } },
          { action: 'update', model: 'tasks', id: 'task-b', data: { rank: 2 } },
        ],
      }),
    ).rejects.toThrow();
    expect(outbox.records.size).toBe(1);

    const replayAttempts: { key: string | null; body: string }[] = [];
    const restarted = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        const headers = init?.headers as Record<string, string>;
        replayAttempts.push({
          key: headers['Idempotency-Key'] ?? null,
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return Promise.resolve(commitResponse(init, 9));
      },
    });

    await restarted.ready();
    expect(replayAttempts).toEqual(firstAttempts);
    expect(outbox.records.size).toBe(0);
  });

  it('decodes a pre-version outbox entry as v1 and replays it as v1', async () => {
    const outbox = new MemoryCommitOutbox();
    const current = await leaveAmbiguousDelete(
      outbox,
      'legacy-protocol-entry',
      'legacy-task',
    );
    const { protocolVersion: _omitted, ...legacyEntry } = current;
    expect(durableHttpCommitEnvelopeSchema.parse(legacyEntry).protocolVersion).toBe(1);
    outbox.records.set(current.id, legacyEntry);

    await expect(replayedProtocolVersion(outbox)).resolves.toBe('1');
    expect(outbox.records.size).toBe(0);
  });

  it('replays the protocol version sealed by a newer SDK after rollback', async () => {
    const outbox = new MemoryCommitOutbox();
    const current = await leaveAmbiguousDelete(
      outbox,
      'newer-protocol-entry',
      'newer-task',
    );
    const newerProtocolVersion = PROTOCOL_VERSION + 1;
    outbox.records.set(current.id, {
      ...current,
      protocolVersion: newerProtocolVersion,
    });

    await expect(replayedProtocolVersion(outbox)).resolves.toBe(
      String(newerProtocolVersion),
    );
    expect(outbox.records.size).toBe(0);
  });

  it('accepts an immediate same-key/same-body retry without timestamp drift', async () => {
    const outbox = new MemoryCommitOutbox();
    let attempts = 0;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('ambiguous disconnect'));
        return Promise.resolve(commitResponse(init, 11));
      },
    });
    const request = {
      idempotencyKey: 'http-key-immediate-retry',
      operations: [{
        action: 'update' as const,
        model: 'tasks',
        id: 'task-1',
        data: { title: 'same-body' },
      }],
    };

    await expect(client.commits.create(request)).rejects.toThrow();
    await expect(client.commits.create(request)).resolves.toMatchObject({
      status: 'confirmed',
      lastSyncId: 11,
    });
    expect(attempts).toBe(2);
    expect(outbox.records.size).toBe(0);
  });

  it('drains an ambiguous predecessor before sending the next write', async () => {
    const outbox = new MemoryCommitOutbox();
    const attemptedKeys: string[] = [];
    let firstAttempt = true;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        const key = (init?.headers as Record<string, string>)['Idempotency-Key'];
        attemptedKeys.push(key ?? 'missing');
        if (firstAttempt) {
          firstAttempt = false;
          return Promise.reject(new Error('ambiguous disconnect'));
        }
        return Promise.resolve(commitResponse(init));
      },
    });

    await expect(client.commits.create({
      idempotencyKey: 'write-a',
      operations: [{ action: 'update', model: 'tasks', id: 'a', data: { rank: 1 } }],
    })).rejects.toThrow();
    await expect(client.commits.create({
      idempotencyKey: 'write-b',
      operations: [{ action: 'update', model: 'tasks', id: 'b', data: { rank: 2 } }],
    })).resolves.toMatchObject({ status: 'confirmed' });

    expect(attemptedKeys).toEqual(['write-a', 'write-a', 'write-b']);
    expect(outbox.records.size).toBe(0);
  });

  it('makes waitForFlush drain writes that failed after startup', async () => {
    const outbox = new MemoryCommitOutbox();
    let attempts = 0;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('ambiguous disconnect'))
          : Promise.resolve(commitResponse(init));
      },
    });

    await expect(client.commits.create({
      idempotencyKey: 'flush-me',
      operations: [{ action: 'delete', model: 'tasks', id: 'old' }],
    })).rejects.toThrow();
    await expect(client.waitForFlush()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(outbox.records.size).toBe(0);
  });

  it('fails closed when a saved write is outside the replay window', async () => {
    const outbox = new MemoryCommitOutbox();
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: () => Promise.reject(new Error('ambiguous disconnect')),
    });
    await expect(client.commits.create({
      idempotencyKey: 'expired-write',
      operations: [{ action: 'delete', model: 'tasks', id: 'old' }],
    })).rejects.toThrow();
    const record = [...outbox.records.values()][0];
    const parsed = durableHttpCommitEnvelopeSchema.safeParse(record);
    if (!parsed.success) throw new Error('missing HTTP record');
    const old = Date.now() - HTTP_COMMIT_REPLAY_WINDOW_MS - 1;
    outbox.records.set(parsed.data.id, {
      ...parsed.data,
      createdAt: old,
      sealedAt: old,
      timestamp: old,
    });

    await expect(client.waitForFlush()).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('replays an accepted source write beyond the hosted idempotency window', async () => {
    const outbox = new MemoryCommitOutbox();
    const correlationId = 'echo_v1_permanent_acceptance';
    const queued = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: 'queued',
          correlationId,
          lastSyncId: 0,
          ops: 1,
        }));
      },
    });
    await queued.commits.create({
      idempotencyKey: 'accepted-after-window',
      operations: [{ action: 'delete', model: 'tasks', id: 'old' }],
      wait: 'queued',
    });

    const raw = [...outbox.records.values()][0];
    const parsed = durableHttpCommitEnvelopeSchema.safeParse(raw);
    if (!parsed.success) throw new Error('missing accepted HTTP record');
    expect(parsed.data).toMatchObject({ correlationId });
    expect(parsed.data.acceptedAt).toEqual(expect.any(Number));
    const old = Date.now() - HTTP_COMMIT_REPLAY_WINDOW_MS - 1;
    outbox.records.set(parsed.data.id, {
      ...parsed.data,
      createdAt: old,
      sealedAt: old,
      timestamp: old,
    });

    const restarted = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: 'confirmed',
          correlationId,
          lastSyncId: 101,
          ops: 1,
        }));
      },
    });

    await expect(restarted.ready()).resolves.toBeUndefined();
    expect(outbox.records.size).toBe(0);
  });

  it('does not settle an outbox record from an invalid 2xx receipt', async () => {
    const outbox = new MemoryCommitOutbox();
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: () => Promise.resolve(response({ status: 'rejected' })),
    });

    await expect(client.commits.create({
      idempotencyKey: 'bad-receipt',
      operations: [{ action: 'update', model: 'tasks', id: 'a', data: { x: 1 } }],
    })).rejects.toMatchObject({ code: 'commit_no_result' });
    expect(outbox.records.size).toBe(1);
  });

  it('fails closed on a queued receipt without a WAL correlation', async () => {
    const outbox = new MemoryCommitOutbox();
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => {
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: 'queued',
          lastSyncId: 0,
          ops: 1,
        }));
      },
    });

    await expect(client.commits.create({
      idempotencyKey: 'queued-without-correlation',
      operations: [
        { action: 'update', model: 'tasks', id: 'a', data: { x: 1 } },
      ],
      wait: 'queued',
    })).rejects.toMatchObject({ code: 'commit_no_result' });
    expect(outbox.records.size).toBe(1);
  });

  it('never executes an untrusted outbox row against a non-write route', async () => {
    const outbox = new MemoryCommitOutbox();
    const idempotencyKey = idempotencyKeySchema.parse('poisoned-row');
    const now = Date.now();
    const id = httpCommitEnvelopeRecordId(idempotencyKey);
    outbox.records.set(id, {
      id,
      type: 'http_commit_envelope',
      storageVersion: 1,
      idempotencyKey,
      protocolVersion: PROTOCOL_VERSION,
      request: {
        method: 'DELETE',
        path: '/v1/capabilities/root',
        body: JSON.stringify({ idempotencyKey }),
      },
      scopeNamespace: 'untrusted',
      createdAt: now,
      sealedAt: now,
      timestamp: now,
    });
    const fetchImpl = jest.fn(() => Promise.resolve(response({})));
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: fetchImpl,
    });

    await expect(client.ready()).rejects.toMatchObject({
      code: 'write_options_invalid',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not report a remote success until local settlement succeeds', async () => {
    const outbox = new MemoryCommitOutbox();
    outbox.failRemove = true;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (_input, init) => Promise.resolve(commitResponse(init)),
    });

    await expect(client.commits.create({
      idempotencyKey: 'cleanup-failed',
      operations: [{ action: 'delete', model: 'tasks', id: 'a' }],
    })).rejects.toMatchObject({ code: 'db_not_opened' });
    expect(outbox.records.size).toBe(1);
  });

  it('never replays one participant\'s record under another participant', async () => {
    const outbox = new MemoryCommitOutbox();
    const first = createHttpTransport({
      apiKey: 'sk_actor_a',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: { ...OUTBOX_SCOPE, participantId: 'actor-a' },
      fetch: () => Promise.reject(new Error('ambiguous disconnect')),
    });
    await expect(first.commits.create({
      idempotencyKey: 'shared-actor-key',
      operations: [{ action: 'delete', model: 'tasks', id: 'a' }],
    })).rejects.toThrow();

    const attemptedKeys: string[] = [];
    const second = createHttpTransport({
      apiKey: 'sk_actor_b',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: { ...OUTBOX_SCOPE, participantId: 'actor-b' },
      fetch: (_input, init) => {
        attemptedKeys.push(
          (init?.headers as Record<string, string>)['Idempotency-Key'] ?? 'missing',
        );
        return Promise.resolve(commitResponse(init));
      },
    });
    await second.commits.create({
      idempotencyKey: 'shared-actor-key',
      operations: [{ action: 'delete', model: 'tasks', id: 'b' }],
    });

    expect(attemptedKeys).toEqual(['shared-actor-key']);
    expect([...outbox.records.values()]).toHaveLength(1);
  });

  it('keeps a generated model id stable across a successful write/readback failure', async () => {
    const outbox = new MemoryCommitOutbox();
    const postedBodies: string[] = [];
    let failFirstRead = true;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      commitOutbox: outbox,
      commitOutboxScope: OUTBOX_SCOPE,
      fetch: (input, init) => {
        void input;
        if (init?.method === 'POST') {
          postedBodies.push(typeof init.body === 'string' ? init.body : '');
          return Promise.resolve(commitResponse(init));
        }
        if (failFirstRead) {
          failFirstRead = false;
          return Promise.reject(new Error('readback disconnected'));
        }
        const posted = JSON.parse(postedBodies[0] ?? '{}') as { id?: string };
        return Promise.resolve(response(modelReadResponse({
          model: 'tasks',
          id: posted.id ?? '',
          data: { id: posted.id, title: 'safe' },
          stamp: 4,
        })));
      },
    });
    const params = {
      idempotencyKey: 'stable-create',
      data: { title: 'safe' },
    };

    await expect(client.model<{ id: string; title: string }>('tasks').create(params)).rejects.toThrow(
      'readback disconnected',
    );
    await expect(client.model<{ id: string; title: string }>('tasks').create(params)).resolves.toMatchObject({
      title: 'safe',
    });
    expect(postedBodies).toHaveLength(2);
    expect(JSON.parse(postedBodies[0] ?? '{}')).toEqual(JSON.parse(postedBodies[1] ?? '{}'));
  });

  it('includes the batch premise in the durable HTTP request', async () => {
    let posted: Record<string, unknown> | undefined;
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      fetch: (_input, init) => {
        posted = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;
        return Promise.resolve(commitResponse(init));
      },
    });

    await client.commits.create({
      idempotencyKey: 'reads-on-http',
      operations: [{ action: 'update', model: 'tasks', id: 'a', data: { x: 1 } }],
      reads: [{ model: 'projects', id: 'p1', readAt: 42 }],
    });
    expect(posted?.reads).toEqual([
      { model: 'projects', id: 'p1', readAt: 42 },
    ]);
  });

  it('returns stale notifications from an HTTP commit receipt', async () => {
    const notification = {
      object: 'stale_notification' as const,
      model: 'tasks',
      id: 'a',
      readAt: 41,
      observedSyncId: 42,
      conflictingFields: ['title'],
      currentValues: { title: 'newer' },
      writtenBy: { kind: 'user' as const, id: 'user-2' },
    };
    const client = createHttpTransport({
      apiKey: 'sk_test_outbox',
      baseURL: 'https://api.example.test',
      fetch: (_input, init) => {
        const clientTxId =
          new Headers(init?.headers).get('Idempotency-Key') ?? 'missing-key';
        return Promise.resolve(response({
          object: 'commit_receipt',
          clientTxId,
          serverTxId: `server-${clientTxId}`,
          success: true,
          status: 'confirmed',
          lastSyncId: 42,
          ops: 1,
          notifications: [notification],
        }));
      },
    });

    await expect(client.commits.create({
      idempotencyKey: 'notify-on-http',
      operations: [{
        action: 'update',
        model: 'tasks',
        id: 'a',
        data: { title: 'mine' },
        readAt: 41,
        onStale: 'notify',
      }],
    })).resolves.toMatchObject({ notifications: [notification] });
  });
});
