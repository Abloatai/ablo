import { createWebSocketSession } from '../websocket/session.js';
import { Ablo } from '../../client/ablo.js';
import { defineSchema, model, z } from '../../schema/index.js';
import { PROTOCOL_VERSION } from '../../wire/protocolVersion.js';
import type { CredentialProviderResult } from '../../auth/credentialResult.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const NOW = '2026-08-30T12:00:00.000Z';
const AUTHORITY = {
  organizationId: 'org-1',
  projectId: 'project-1',
  branchId: 'branch-1',
  syncGroups: ['org:org-1'],
  operations: [],
  participantKind: 'agent' as const,
  participantId: 'agent-1',
  deliveryPartition: null,
};

const IDENTITY = {
  participantKind: 'agent' as const,
  participantId: 'agent-1',
  accountScope: 'org-1',
  projectId: 'project-1',
  branchId: 'branch-1',
  branchRoot: false,
  syncGroups: ['org:org-1'],
  deliveryPartition: null,
  authority: AUTHORITY,
  userMeta: {},
};

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];

  constructor(
    readonly url: string,
    readonly protocols: readonly string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  serverClose(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value) as Record<string, unknown>);
  }

  close(): void {
    this.serverClose(1000, 'closed');
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function access(
  credential: CredentialProviderResult | (() => CredentialProviderResult | Promise<CredentialProviderResult>),
  renewable = false,
) {
  return {
    renewable,
    credential: () => Promise.resolve(
      typeof credential === 'function' ? credential() : credential,
    ),
  };
}

async function waitFor(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe('agent WebSocket transport', () => {
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: FakeWebSocket,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
    jest.useRealTimers();
  });

  it('defaults a session client to one WebSocket for commits and claims', async () => {
    const schema = defineSchema({ items: model({ done: z.boolean() }) });
    const client = Ablo({
      schema,
      session: {
        object: 'session',
        token: 'rk_agent_1',
        expiresAt: '2030-08-30T12:00:00.000Z',
      },
      baseURL: 'https://cell.example.test',
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        participantKind: 'agent',
        participantId: 'agent-1',
        accountScope: 'org-1',
        projectId: 'project-1',
        branchId: 'branch-1',
        branchRoot: false,
        syncGroups: ['org:org-1'],
        deliveryPartition: null,
        authority: AUTHORITY,
        userMeta: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    });

    const opening = client.ready();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await opening;

    const committing = client.commits.create({
      idempotencyKey: 'commit-public-1',
      operations: [{ action: 'update', model: 'items', id: 'item-1', data: { done: true } }],
    });
    const claiming = client.items.claim('item-1', { queue: true });
    await waitFor(() => {
      expect(socket.sent.some((frame) => frame.type === 'commit')).toBe(true);
      expect(socket.sent.some((frame) => frame.type === 'claim_begin')).toBe(true);
    });

    const commitFrame = socket.sent.find((frame) => frame.type === 'commit');
    expect(commitFrame).toMatchObject({
      payload: {
        clientTxId: 'commit-public-1',
        operations: [{ type: 'UPDATE', model: 'items', id: 'item-1', input: { done: true } }],
      },
    });
    const claimFrame = socket.sent.find((frame) => frame.type === 'claim_begin');
    const claimId = (claimFrame?.payload as { claimId: string }).claimId;
    expect(FakeWebSocket.instances).toHaveLength(1);

    socket.receive({
      type: 'mutation_result',
      payload: {
        object: 'commit_receipt', clientTxId: 'commit-public-1', serverTxId: 'server-public-1',
        success: true, ops: 1, authority: AUTHORITY, createdAt: NOW,
        status: 'confirmed', statusAt: NOW, lastSyncId: 9,
      },
    });
    socket.receive({
      type: 'claim_acquired',
      payload: {
        claimId, fenceToken: 5, readAt: 9,
        target: { entityType: 'items', entityId: 'item-1' },
      },
    });

    await expect(committing).resolves.toMatchObject({ status: 'confirmed', lastSyncId: 9 });
    const claim = await claiming;
    expect(claim).toMatchObject({ id: claimId, fenceToken: 5 });
    await claim.release();
    await flush();
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'claim_abandon', payload: { claimId, entityType: 'items', entityId: 'item-1' },
    });
    await client.dispose();
  });

  it('shares one renewable session across HTTP bootstrap and WebSocket setup', async () => {
    const schema = defineSchema({ items: model({ done: z.boolean() }) });
    const provideSession = jest.fn(async () => ({
      object: 'session' as const,
      token: 'rk_agent_renewable',
      expiresAt: '2030-08-30T12:00:00.000Z',
    }));
    const client = Ablo({
      schema,
      session: provideSession,
      groups: ['org:org-1'],
      baseURL: 'https://cell.example.test',
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBe(
          'Bearer rk_agent_renewable',
        );
        return jsonResponse(IDENTITY);
      },
    });

    const opening = client.ready();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.protocols).toContain('ablo.bearer.rk_agent_renewable');
    socket.open();
    await opening;

    expect(provideSession).toHaveBeenCalledTimes(1);
    await client.dispose();
  });

  it('opens one authenticated socket and multiplexes commits, row claims, and subscriptions', async () => {
    const opening = createWebSocketSession({
      baseUrl: 'https://cell.example.test',
      access: access('rk_agent_1'),
      syncGroups: ['org:org-1'],
    });
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const session = await opening;

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.protocols).toContain('ablo.bearer.rk_agent_1');
    expect(socket.sent.map((frame) => frame.type)).toEqual([
      'presence_update',
      'sync_request',
    ]);
    expect(socket.sent[1]).toMatchObject({
      type: 'sync_request',
      payload: { protocolVersion: PROTOCOL_VERSION },
    });

    const committed = session.commit({
      clientTxId: 'commit-1',
      operations: [{ type: 'UPDATE', model: 'items', id: 'item-1', input: { done: true } }],
    });
    const claimed = session.claim({
      claimId: 'claim-1',
      entityType: 'items',
      entityId: 'item-1',
      description: 'finish item',
      queue: true,
    });
    const subscribed = session.updateSubscription(['item:item-1']);
    await flush();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent.slice(-3).map((frame) => frame.type)).toEqual([
      'commit',
      'claim_begin',
      'update_subscription',
    ]);

    socket.receive({
      type: 'subscription_ack',
      payload: { success: true, syncGroups: ['item:item-1'] },
    });
    socket.receive({
      type: 'claim_queued',
      payload: {
        claimId: 'claim-1',
        position: 1,
        target: { entityType: 'items', entityId: 'item-1' },
      },
    });
    socket.receive({
      type: 'mutation_result',
      payload: {
        object: 'commit_receipt',
        clientTxId: 'commit-1',
        serverTxId: 'server-1',
        success: true,
        ops: 1,
        authority: AUTHORITY,
        createdAt: NOW,
        status: 'confirmed',
        statusAt: NOW,
        lastSyncId: 8,
      },
    });
    socket.receive({
      type: 'claim_granted',
      payload: {
        claimId: 'claim-1',
        fenceToken: 4,
        readAt: 8,
        target: { entityType: 'items', entityId: 'item-1' },
      },
    });

    await expect(committed).resolves.toMatchObject({ status: 'confirmed', lastSyncId: 8 });
    await expect(claimed).resolves.toMatchObject({ claimId: 'claim-1', fenceToken: 4 });
    await expect(subscribed).resolves.toEqual({ syncGroups: ['item:item-1'] });
    await session.close();
  });

  it('matches HTTP commit identity, confirmation, attribution, and conflict errors', async () => {
    const schema = defineSchema({ items: model({ done: z.boolean() }) });
    let httpIdempotencyKey: string | null = null;
    const http = Ablo({
      schema,
      transport: 'http',
      apiKey: 'rk_agent_1',
      baseURL: 'https://cell.example.test',
      fetch: (input, init) => {
        const url = typeof input === 'string'
          ? input
          : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        if (path.endsWith('/auth/identity')) return Promise.resolve(jsonResponse(IDENTITY));
        httpIdempotencyKey = new Headers(init?.headers).get('Idempotency-Key');
        if (httpIdempotencyKey === 'parity-conflict') {
          return Promise.resolve(jsonResponse({
            error: {
              code: 'entity_claimed',
              message: 'items/item-1 is claimed',
              details: { heldByClaimId: 'claim-other' },
            },
          }, 409));
        }
        return Promise.resolve(jsonResponse({
          object: 'commit_receipt', clientTxId: httpIdempotencyKey,
          serverTxId: 'server-parity', success: true, ops: 1, authority: AUTHORITY,
          createdAt: NOW, status: 'confirmed', statusAt: NOW, lastSyncId: 12,
        }));
      },
    });
    const httpReceipt = await http.commits.create({
      idempotencyKey: 'parity-success',
      operations: [{ action: 'update', model: 'items', id: 'item-1', data: { done: true } }],
    });
    expect(httpIdempotencyKey).toBe('parity-success');

    const websocket = Ablo({
      schema,
      session: {
        object: 'session',
        token: 'rk_agent_1',
        expiresAt: '2030-08-30T12:00:00.000Z',
      },
      baseURL: 'https://cell.example.test',
      fetch: () => Promise.resolve(jsonResponse(IDENTITY)),
    });
    const opening = websocket.ready();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    await opening;
    const wsCommit = websocket.commits.create({
      idempotencyKey: 'parity-success',
      operations: [{ action: 'update', model: 'items', id: 'item-1', data: { done: true } }],
    });
    await waitFor(() => expect(socket.sent.some((frame) => frame.type === 'commit')).toBe(true));
    expect(socket.sent.find((frame) => frame.type === 'commit')).toMatchObject({
      payload: { clientTxId: 'parity-success' },
    });
    socket.receive({
      type: 'mutation_result',
      payload: {
        object: 'commit_receipt', clientTxId: 'parity-success',
        serverTxId: 'server-parity', success: true, ops: 1, authority: AUTHORITY,
        createdAt: NOW, status: 'confirmed', statusAt: NOW, lastSyncId: 12,
      },
    });
    await expect(wsCommit).resolves.toEqual(httpReceipt);

    const httpConflict = http.commits.create({
      idempotencyKey: 'parity-conflict',
      operations: [{ action: 'update', model: 'items', id: 'item-1', data: { done: false } }],
    });
    await expect(httpConflict).rejects.toMatchObject({
      code: 'entity_claimed',
      details: { heldByClaimId: 'claim-other' },
    });
    const wsConflict = websocket.commits.create({
      idempotencyKey: 'parity-conflict',
      operations: [{ action: 'update', model: 'items', id: 'item-1', data: { done: false } }],
    });
    await waitFor(() => expect(socket.sent.filter((frame) => frame.type === 'commit')).toHaveLength(2));
    socket.receive({
      type: 'mutation_result',
      payload: {
        clientTxId: 'parity-conflict',
        success: false,
        error: {
          code: 'entity_claimed',
          message: 'items/item-1 is claimed',
          details: { heldByClaimId: 'claim-other' },
        },
      },
    });
    await expect(wsConflict).rejects.toMatchObject({
      code: 'entity_claimed',
      details: { heldByClaimId: 'claim-other' },
    });
    await websocket.dispose();
    await http.dispose();
  });

  it('retains nothing while idle and catches up from the durable position when observation starts', async () => {
    const saved: string[] = [];
    const opening = createWebSocketSession({
      access: access('rk_agent_1'),
      reconnectDelay: 0,
      maxReconnectDelay: 0,
      cursorStore: {
        load: () => Promise.resolve(JSON.stringify({ lastSyncId: 5, cursor: null })),
        save: (_key, cursor) => { saved.push(cursor); return Promise.resolve(); },
      },
    });
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const session = await opening;
    // This push arrives while no observer exists. The session must not retain
    // it in memory; observation asks the server to replay from durable id 5.
    socket.receive({
      type: 'delta',
      payload: {
        id: 99, actionType: 'U', modelName: 'items', modelId: 'idle-only',
        data: { id: 'idle-only', done: true }, syncGroups: ['item:idle-only'], createdAt: NOW,
      },
    });

    const iterator = session.observe()[Symbol.asyncIterator]();
    const observing = iterator.next();
    await flush();
    expect(socket.sent.at(-1)).toMatchObject({
      type: 'sync_request', payload: { lastSyncId: 5, cursor: null },
    });
    socket.receive({
      type: 'sync_response',
      payload: {
        deltas: [{
          id: 6, actionType: 'U', modelName: 'items', modelId: 'item-1',
          data: { id: 'item-1', done: true }, syncGroups: ['item:item-1'], createdAt: NOW,
        }],
        newCursor: 'opaque-ahead-of-application',
      },
    });
    const observed = await observing;
    expect(observed.value?.id).toBe(6);
    expect(socket.sent.some((frame) => frame.type === 'ack')).toBe(false);
    await observed.value?.checkpoint();
    expect(saved).toEqual([JSON.stringify({ lastSyncId: 6, cursor: null })]);
    expect(socket.sent.at(-1)).toEqual({ type: 'ack', payload: { lastSyncId: 6 } });
    await iterator.return?.();
    await session.close();
  });

  it('retries durable persistence when checkpointing fails and acknowledges only after success', async () => {
    let saves = 0;
    const opening = createWebSocketSession({
      access: access('rk_agent_1'),
      reconnectDelay: 0,
      maxReconnectDelay: 0,
      cursorStore: {
        load: () => Promise.resolve(null),
        save: () => {
          saves += 1;
          return saves === 1
            ? Promise.reject(new Error('disk unavailable'))
            : Promise.resolve();
        },
      },
    });
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const session = await opening;
    const iterator = session.observe()[Symbol.asyncIterator]();
    const observing = iterator.next();
    await flush();
    socket.receive({
      type: 'delta',
      payload: {
        id: 1, actionType: 'C', modelName: 'items', modelId: 'item-1',
        data: { id: 'item-1', done: false }, syncGroups: ['item:item-1'], createdAt: NOW,
      },
    });
    const observed = await observing;

    await expect(observed.value?.checkpoint()).rejects.toThrow('disk unavailable');
    expect(socket.sent.some((frame) => frame.type === 'ack')).toBe(false);
    socket.serverClose(1006, 'network_lost');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const reconnected = FakeWebSocket.instances[1]!;
    reconnected.open();
    await flush();
    expect(reconnected.sent).toContainEqual(expect.objectContaining({
      type: 'sync_request', payload: expect.objectContaining({ lastSyncId: 0 }),
    }));
    await expect(observed.value?.checkpoint()).resolves.toBeUndefined();
    expect(saves).toBe(2);
    expect(reconnected.sent.at(-1)).toEqual({ type: 'ack', payload: { lastSyncId: 1 } });
    await iterator.return?.();
    await session.close();
  });

  it('fails observation at a bounded backlog and resumes from the durable cursor', async () => {
    const opening = createWebSocketSession({ access: access('rk_agent_1') });
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const session = await opening;
    const iterator = session.observe()[Symbol.asyncIterator]();
    const first = iterator.next();
    await flush();
    const delta = (id: number) => ({
      type: 'delta',
      payload: {
        id, actionType: 'U', modelName: 'items', modelId: `item-${id}`,
        data: { id: `item-${id}`, done: true }, syncGroups: [`item:item-${id}`], createdAt: NOW,
      },
    });
    socket.receive(delta(1));
    await expect(first).resolves.toMatchObject({ value: { id: 1 } });
    for (let id = 2; id <= 1_026; id += 1) socket.receive(delta(id));
    await expect(iterator.next()).rejects.toMatchObject({ code: 'observation_buffer_overflow' });
    await session.close();
  });

  it('refreshes an expired credential before reconnecting', async () => {
    let token = 'rk_old';
    const opening = createWebSocketSession({
      access: access(() => token, true),
      reconnectDelay: 0,
      maxReconnectDelay: 0,
    });
    await flush();
    FakeWebSocket.instances[0]!.open();
    const session = await opening;

    token = 'rk_new';
    FakeWebSocket.instances[0]!.serverClose(4001, 'credential_expired');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(FakeWebSocket.instances[1]!.protocols).toContain('ablo.bearer.rk_new');
    FakeWebSocket.instances[1]!.open();
    await session.close();
  });

  it('keeps an established session reconnecting after a replacement socket fails its handshake', async () => {
    const opening = createWebSocketSession({
      access: access('rk_agent_1'),
      reconnectDelay: 0,
      maxReconnectDelay: 0,
    });
    await flush();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    const session = await opening;

    first.serverClose(1006, 'network_lost');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    FakeWebSocket.instances[1]!.serverClose(1006, 'replacement_handshake_failed');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(3));

    const third = FakeWebSocket.instances[2]!;
    third.open();
    await expect(session.ready()).resolves.toBeUndefined();
    await session.close();
  });

  it('keeps durable observation alive across renewable credential expiry', async () => {
    let token = 'rk_old';
    const opening = createWebSocketSession({
      access: access(() => token, true),
      reconnectDelay: 0,
      maxReconnectDelay: 0,
    });
    await flush();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    const session = await opening;
    const iterator = session.observe()[Symbol.asyncIterator]();
    const next = iterator.next();
    await flush();

    token = 'rk_new';
    first.serverClose(4001, 'credential_expired');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const renewed = FakeWebSocket.instances[1]!;
    expect(renewed.protocols).toContain('ablo.bearer.rk_new');
    renewed.open();
    renewed.receive({
      type: 'delta',
      payload: {
        id: 1, actionType: 'C', modelName: 'items', modelId: 'item-renewed',
        data: { id: 'item-renewed', done: false },
        syncGroups: ['item:item-renewed'], createdAt: NOW,
      },
    });

    await expect(next).resolves.toMatchObject({ value: { id: 1, modelId: 'item-renewed' } });
    await iterator.return?.();
    await session.close();
  });

  it('pre-rolls a renewable headless session before its credential expires', async () => {
    jest.useFakeTimers();
    const getCredential = jest.fn(async () => getCredential.mock.calls.length === 1
      ? {
          object: 'session' as const,
          token: 'rk_short_lived',
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        }
      : {
          object: 'session' as const,
          token: 'rk_prerolled',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        });
    const opening = createWebSocketSession({
      access: access(getCredential, true),
      reconnectDelay: 0,
      maxReconnectDelay: 0,
    });
    await flush();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    const session = await opening;

    await jest.advanceTimersByTimeAsync(30_000);
    expect(getCredential).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);

    first.serverClose(4001, 'credential_expired');
    await jest.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]!.protocols).toContain('ablo.bearer.rk_prerolled');
    FakeWebSocket.instances[1]!.open();
    await session.close();
  });

  it('treats expiry of a static session as terminal', async () => {
    const opening = createWebSocketSession({ access: access('rk_static') });
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    const session = await opening;
    const iterator = session.observe()[Symbol.asyncIterator]();
    const next = iterator.next();
    await flush();

    socket.serverClose(4001, 'credential_expired');
    await expect(next).rejects.toMatchObject({ name: 'AbloSessionError' });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await session.close();
  });

  it('derives browser versus agent connection kind from the session credential', async () => {
    const opening = createWebSocketSession({ access: access('ek_user_1') });
    await flush();
    const socket = FakeWebSocket.instances[0]!;
    expect(new URL(socket.url).searchParams.has('kind')).toBe(false);
    socket.open();
    const session = await opening;
    await session.close();
  });

  it('resumes from the persisted position, deduplicates replay, and never retries an ambiguous commit implicitly', async () => {
    const saved: string[] = [];
    const opening = createWebSocketSession({
      access: access('rk_agent_1'),
      reconnectDelay: 0,
      maxReconnectDelay: 0,
      cursorStore: {
        load: () => Promise.resolve(JSON.stringify({ lastSyncId: 5, cursor: null })),
        save: (_key, cursor) => { saved.push(cursor); return Promise.resolve(); },
      },
    });
    await flush();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    const session = await opening;
    const iterator = session.observe()[Symbol.asyncIterator]();
    const firstDelta = iterator.next();
    await flush();
    first.receive({
      type: 'delta',
      payload: {
        id: 6, actionType: 'U', modelName: 'items', modelId: 'item-1',
        data: { id: 'item-1', done: true }, syncGroups: ['item:item-1'], createdAt: NOW,
      },
    });
    const observed = await firstDelta;
    await observed.value?.checkpoint();
    expect(saved).toEqual([JSON.stringify({ lastSyncId: 6, cursor: null })]);

    const ambiguous = session.commit({
      clientTxId: 'ambiguous-1',
      operations: [{ type: 'UPDATE', model: 'items', id: 'item-1', input: { done: false } }],
    });
    await flush();
    first.serverClose(1006, 'network_lost');
    await expect(ambiguous).rejects.toMatchObject({ code: 'commit_no_result' });

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const second = FakeWebSocket.instances[1]!;
    second.open();
    await flush();
    expect(second.sent).toContainEqual(expect.objectContaining({
      type: 'sync_request', payload: expect.objectContaining({ lastSyncId: 6 }),
    }));
    expect(second.sent.some((frame) => frame.type === 'commit')).toBe(false);

    const nextDelta = iterator.next();
    await flush();
    second.receive({
      type: 'sync_response',
      payload: {
        deltas: [
          {
            id: 6, actionType: 'U', modelName: 'items', modelId: 'item-1',
            data: { id: 'item-1', done: true }, syncGroups: ['item:item-1'], createdAt: NOW,
          },
          {
            id: 7, actionType: 'U', modelName: 'items', modelId: 'item-2',
            data: { id: 'item-2', done: true }, syncGroups: ['item:item-2'], createdAt: NOW,
          },
        ],
      },
    });
    await expect(nextDelta).resolves.toMatchObject({ value: { id: 7 } });

    const retry = session.commit({
      clientTxId: 'ambiguous-1',
      operations: [{ type: 'UPDATE', model: 'items', id: 'item-1', input: { done: false } }],
    });
    await flush();
    expect(second.sent.filter((frame) => frame.type === 'commit')).toHaveLength(1);
    second.receive({
      type: 'mutation_result',
      payload: {
        object: 'commit_receipt', clientTxId: 'ambiguous-1', serverTxId: 'server-cached-1',
        success: true, ops: 1, authority: AUTHORITY, createdAt: NOW,
        status: 'confirmed', statusAt: NOW, lastSyncId: 7,
      },
    });
    await expect(retry).resolves.toMatchObject({ serverTxId: 'server-cached-1' });
    await iterator.return?.();
    await session.close();
  });

  it('closes a socket that is still opening when the client is disposed', async () => {
    const schema = defineSchema({ items: model({ done: z.boolean() }) });
    const client = Ablo({
      schema,
      session: {
        object: 'session',
        token: 'rk_agent_1',
        expiresAt: '2030-08-30T12:00:00.000Z',
      },
      baseURL: 'https://cell.example.test',
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        participantKind: 'agent', participantId: 'agent-1', accountScope: 'org-1',
        projectId: 'project-1', branchId: 'branch-1', branchRoot: false,
        syncGroups: ['org:org-1'], deliveryPartition: null, authority: AUTHORITY, userMeta: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
    });
    const opening = client.ready();
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    await client.dispose();
    await expect(opening).rejects.toThrow('disposed');
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it('rejects an incompatible protocol version explicitly', async () => {
    const opening = createWebSocketSession({ access: access('rk_agent_1') });
    await flush();
    FakeWebSocket.instances[0]!.serverClose(4010, 'protocol_version_unsupported');
    await expect(opening).rejects.toMatchObject({ code: 'protocol_version_unsupported' });
  });
});
