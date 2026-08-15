import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import {
  dataSource,
  signAbloSourceRequest,
  sourceEventForOperation,
} from '../index.js';

class TestResponse {
  readonly status: number;
  private readonly text: string;

  constructor(body: string, init?: { status?: number }) {
    this.text = body;
    this.status = init?.status ?? 200;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.text);
  }
}

(globalThis as unknown as { Response: typeof Response }).Response =
  TestResponse as unknown as typeof Response;

const schema = defineSchema({
  files: model({
    path: z.string(),
    content: z.string().optional(),
  }),
});

const TEST_API_KEY = 'sk_test_source_key';

describe('sourceEventForOperation', () => {
  it('builds the outbox marker for a committed operation', () => {
    const event = sourceEventForOperation({
      eventId: 'evt_1',
      operation: {
        type: 'UPDATE',
        model: 'files',
        id: 'src/a.ts',
        input: { content: 'next' },
        transactionId: 'op_1',
      },
      data: { id: 'src/a.ts', content: 'next' },
      correlationId: 'corr_1',
      organizationId: 'org_1',
      occurredAt: new Date('2026-06-02T12:00:00.000Z'),
    });

    expect(event).toEqual({
      id: 'evt_1',
      model: 'files',
      entityId: 'src/a.ts',
      type: 'UPDATE',
      data: { id: 'src/a.ts', content: 'next' },
      correlationId: 'corr_1',
      transactionId: 'op_1',
      organizationId: 'org_1',
      occurredAt: Date.parse('2026-06-02T12:00:00.000Z'),
    });
  });

  it('uses explicit entityId for generated-id creates', () => {
    const event = sourceEventForOperation({
      eventId: 'evt_generated',
      operation: {
        type: 'CREATE',
        model: 'files',
        input: { content: 'created' },
      },
      entityId: 'generated_1',
      data: { id: 'generated_1', content: 'created' },
    });

    expect(event).toMatchObject({
      id: 'evt_generated',
      model: 'files',
      entityId: 'generated_1',
      type: 'CREATE',
    });
  });

  it('throws when neither operation.id nor entityId is available', () => {
    expect(() =>
      sourceEventForOperation({
        eventId: 'evt_missing',
        operation: {
          type: 'CREATE',
          model: 'files',
          input: { content: 'created' },
        },
      }),
    ).toThrow(/entityId/);
  });
});

async function post(handler: (request: Request) => Promise<Response>, body: unknown) {
  return signedPost(handler, body, TEST_API_KEY);
}

async function unsignedPost(handler: (request: Request) => Promise<Response>, body: unknown) {
  const response = await handler(
    {
      method: 'POST',
      json: async () => body,
    } as Request,
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

async function signedPost(
  handler: (request: Request) => Promise<Response>,
  body: unknown,
  apiKey: string,
) {
  const rawBody = JSON.stringify(body);
  const signed = await signAbloSourceRequest({
    apiKey,
    body: rawBody,
    messageId: 'msg_test',
  });
  const response = await handler(
    {
      method: 'POST',
      text: async () => rawBody,
      headers: new Headers(signed.headers),
    } as Request,
  );
  return {
    status: response.status,
    body: await response.json(),
  };
}

describe('dataSource', () => {
  it('creates the public Data Source handler', async () => {
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      files: {
        async load({ id }) {
          return { id, path: id };
        },
      },
    });

    await expect(post(handler, { type: 'load', model: 'files', id: 'src/foo.ts' }))
      .resolves.toMatchObject({
        status: 200,
        body: { row: { id: 'src/foo.ts', path: 'src/foo.ts' } },
      });
  });

  it('routes load/list/commit without exposing a database adapter', async () => {
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      async authorize() {
        return { accountScope: 'acct_123' };
      },
      files: {
        async load({ id, context }) {
          expect((context.auth as { accountScope: string }).accountScope).toBe('acct_123');
          return { id, path: id, content: 'hello' };
        },
        async list({ query }) {
          return [{ id: 'src/foo.ts', path: 'src/foo.ts', query }];
        },
        async commit({ operations, clientTxId }) {
          return {
            rows: operations.map((op) => ({
              id: op.id ?? 'generated',
              path: String(op.input?.path ?? op.id ?? 'generated'),
              clientTxId,
            })),
          };
        },
      },
    });

    await expect(post(handler, { type: 'load', model: 'files', id: 'src/foo.ts' }))
      .resolves.toMatchObject({
        status: 200,
        body: { row: { id: 'src/foo.ts', path: 'src/foo.ts' } },
      });

    await expect(post(handler, { type: 'list', model: 'files', query: { limit: 1 } }))
      .resolves.toMatchObject({
        status: 200,
        body: { rows: [{ id: 'src/foo.ts', path: 'src/foo.ts' }] },
      });

    await expect(
      post(handler, {
        type: 'commit',
        operations: [
          {
            type: 'UPDATE',
            model: 'files',
            id: 'src/foo.ts',
            input: { path: 'src/foo.ts' },
          },
        ],
        clientTxId: 'tx_1',
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { rows: [{ id: 'src/foo.ts', path: 'src/foo.ts', clientTxId: 'tx_1' }] },
    });
  });

  it('lets top-level commit keep cross-model operations atomic', async () => {
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      async commit({ operations, clientTxId }) {
        return {
          rows: operations.map((op) => ({
            id: op.id,
            model: op.model,
            clientTxId,
          })),
        };
      },
    });

    await expect(
      post(handler, {
        type: 'commit',
        operations: [
          { type: 'UPDATE', model: 'files', id: 'src/foo.ts' },
          { type: 'CREATE', model: 'fileVersions', id: 'v1' },
        ],
        clientTxId: 'tx_cross_model',
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        rows: [
          { id: 'src/foo.ts', model: 'files', clientTxId: 'tx_cross_model' },
          { id: 'v1', model: 'fileVersions', clientTxId: 'tx_cross_model' },
        ],
      },
    });
  });

  it('passes a connected-plane WAL echo requirement to the customer commit handler', async () => {
    let seenEcho: unknown;
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      commit({ echo }) {
        seenEcho = echo;
        return { rows: [] };
      },
    });

    await expect(
      post(handler, {
        type: 'commit',
        operations: [{ type: 'UPDATE', model: 'files', id: 'src/foo.ts' }],
        clientTxId: 'tx_echo_1',
        intentHash: 'a'.repeat(64),
        echo: { kind: 'postgres-wal', payload: 'echo-payload' },
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(seenEcho).toEqual({
      kind: 'postgres-wal',
      payload: 'echo-payload',
    });
  });

  it('verifies source signatures before authorize runs', async () => {
    let authorized = false;
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      async authorize() {
        authorized = true;
        return {};
      },
      files: {
        async list() {
          return [];
        },
      },
    });

    // The verifier checks `webhook-id` first per the Standard
    // Webhooks spec (it's part of the HMAC input, so missing-id is
    // unverifiable regardless of timestamp/signature presence).
    await expect(
      unsignedPost(handler, { type: 'list', model: 'files' }),
    ).resolves.toMatchObject({
      status: 401,
      body: { error: 'source_id_missing' },
    });
    expect(authorized).toBe(false);
  });

  it('accepts apiKey as the only source credential', async () => {
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      files: {
        async load({ id }) {
          return { id, path: id };
        },
      },
    });

    await expect(
      signedPost(
        handler,
        { type: 'load', model: 'files', id: 'src/foo.ts' },
        'sk_test_source_key',
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { row: { id: 'src/foo.ts', path: 'src/foo.ts' } },
    });
  });

  it('passes pagination cursor through and surfaces nextCursor in the response', async () => {
    const seenCursors: (string | undefined)[] = [];
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      files: {
        async list({ query }) {
          seenCursors.push(query.cursor);
          if (!query.cursor) {
            return {
              rows: [{ id: 'a', path: 'src/a.ts' }],
              nextCursor: 'page_2',
            };
          }
          if (query.cursor === 'page_2') {
            return { rows: [{ id: 'b', path: 'src/b.ts' }] };
          }
          return [];
        },
      },
    });

    await expect(
      post(handler, { type: 'list', model: 'files' }),
    ).resolves.toMatchObject({
      status: 200,
      body: { rows: [{ id: 'a', path: 'src/a.ts' }], nextCursor: 'page_2' },
    });
    await expect(
      post(handler, {
        type: 'list',
        model: 'files',
        query: { cursor: 'page_2' },
      }),
    ).resolves.toMatchObject({
      status: 200,
      body: { rows: [{ id: 'b', path: 'src/b.ts' }] },
    });
    expect(seenCursors).toEqual([undefined, 'page_2']);
  });

  it('routes external-write events through the events handler', async () => {
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      async events({ cursor, limit }) {
        if (!cursor) {
          return {
            events: [
              {
                id: 'evt_1',
                model: 'files',
                entityId: 'src/x.ts',
                type: 'UPDATE',
                data: { path: 'src/x.ts' },
              },
            ],
            nextCursor: 'cursor_2',
          };
        }
        if (cursor === 'cursor_2' && limit) {
          return { events: [] };
        }
        return { events: [] };
      },
    });

    await expect(
      post(handler, { type: 'events' }),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        events: [
          { id: 'evt_1', model: 'files', entityId: 'src/x.ts', type: 'UPDATE' },
        ],
        nextCursor: 'cursor_2',
      },
    });
    await expect(
      post(handler, { type: 'events', cursor: 'cursor_2', limit: 10 }),
    ).resolves.toMatchObject({
      status: 200,
      body: { events: [] },
    });
  });

  it('returns 404 when events handler is not configured', async () => {
    const handler = dataSource({ schema, apiKey: TEST_API_KEY });
    await expect(
      post(handler, { type: 'events' }),
    ).resolves.toMatchObject({
      status: 404,
      body: { error: 'source_events_not_configured' },
    });
  });

  it('enforces resolveScopes — denies operations outside the scope set', async () => {
    // A read-only key: granted only `list`. A `commit` request must
    // be rejected before the commit handler runs.
    let commitInvoked = false;
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      resolveScopes: () => ['list'],
      async commit() {
        commitInvoked = true;
        return {};
      },
      files: {
        async list() {
          return [];
        },
      },
    });

    await expect(
      post(handler, { type: 'list', model: 'files' }),
    ).resolves.toMatchObject({ status: 200 });

    await expect(
      post(handler, {
        type: 'commit',
        operations: [{ type: 'CREATE', model: 'files', id: 'a' }],
      }),
    ).resolves.toMatchObject({
      status: 403,
      body: { error: 'source_forbidden', required: 'commit' },
    });

    expect(commitInvoked).toBe(false);
  });

  it('omitting resolveScopes leaves all operations allowed', async () => {
    // No resolveScopes set: both list and commit succeed without 403.
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      async commit({ operations }) {
        return { rows: operations.map((op) => ({ id: op.id ?? '?' })) };
      },
      files: {
        async list() {
          return [];
        },
      },
    });

    await expect(
      post(handler, { type: 'list', model: 'files' }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      post(handler, {
        type: 'commit',
        operations: [{ type: 'CREATE', model: 'files', id: 'a' }],
      }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('resolveScopes receives the auth context and request body for key lookup', async () => {
    // Customer extracts a key id from a custom header, looks up
    // scopes for that key, and returns the set.
    const seen: { auth?: unknown; bodyType?: string } = {};
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      async authorize() {
        return { keyId: 'reader_key' };
      },
      resolveScopes: ({ auth, body }) => {
        seen.auth = auth;
        seen.bodyType = body.type;
        return (auth).keyId === 'reader_key'
          ? ['list', 'load']
          : ['list', 'load', 'commit'];
      },
      files: {
        async list() {
          return [];
        },
      },
    });

    await post(handler, { type: 'list', model: 'files' });
    expect(seen.auth).toMatchObject({ keyId: 'reader_key' });
    expect(seen.bodyType).toBe('list');
  });

  it('round-trips immutable branch identity through source scope', async () => {
    const seenBranches: (string | undefined)[] = [];
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      files: {
        async list({ context }) {
          seenBranches.push(context.scope?.branchId);
          return [];
        },
      },
    });

    await post(handler, {
      type: 'list',
      model: 'files',
      scope: { branchId: 'br_preview', organizationId: 'org_1' },
    });
    await post(handler, {
      type: 'list',
      model: 'files',
      scope: { branchId: 'br_main', organizationId: 'org_1' },
    });

    expect(seenBranches).toEqual(['br_preview', 'br_main']);
  });

  it('exposes scope context to authorize and list handlers', async () => {
    const seenScope: { authorize?: unknown; list?: unknown } = {};
    const handler = dataSource({
      schema,
      apiKey: TEST_API_KEY,
      async authorize({ body }) {
        seenScope.authorize = (
          body as { scope?: unknown }
        ).scope;
        return {};
      },
      files: {
        async list({ context }) {
          seenScope.list = context.scope;
          return [];
        },
      },
    });

    await post(handler, {
      type: 'list',
      model: 'files',
      scope: {
        participantId: 'user_42',
        participantKind: 'user',
        organizationId: 'org_99',
        branchId: 'br_preview',
        workspaceId: 'proj_docs',
        requiredSyncGroups: ['org:org_99', 'user:user_42'],
      },
    });

    expect(seenScope.authorize).toMatchObject({
      participantId: 'user_42',
      requiredSyncGroups: ['org:org_99', 'user:user_42'],
    });
    expect(seenScope.list).toMatchObject({
      participantKind: 'user',
      organizationId: 'org_99',
      branchId: 'br_preview',
      workspaceId: 'proj_docs',
    });
  });

  it('accepts valid signed source requests and exposes request metadata', async () => {
    const handler = dataSource({
      schema,
      apiKey: 'source_api_key',
      async authorize({ rawBody }) {
        return { rawBody };
      },
      files: {
        async list({ context }) {
          return [
            {
              id: 'src/foo.ts',
              path: 'src/foo.ts',
              messageId: context.messageId,
              signedAt: context.signedAt,
              rawBody: (context.auth as { rawBody: string }).rawBody,
            },
          ];
        },
      },
    });

    await expect(
      signedPost(handler, { type: 'list', model: 'files' }, 'source_api_key'),
    ).resolves.toMatchObject({
      status: 200,
      body: {
        rows: [
          {
            id: 'src/foo.ts',
            messageId: 'msg_test',
            rawBody: JSON.stringify({ type: 'list', model: 'files' }),
          },
        ],
      },
    });
  });
});
