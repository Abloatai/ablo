/**
 * Architectural pin: one WebSocket per tab for the engine + its own
 * presence/intent streams.
 *
 * The user's concern this pin guards: "I don't want my web app to
 * initialize both a sync engine and a mesh client that each open
 * their own WebSocket for the same user." Pre-collapse, the
 * `<AbloProvider>` constructed both `createSyncEngine` AND
 * `createMesh` eagerly, and presence observation constructed a SyncAgent
 * that opened a SECOND socket.
 *
 * Post-collapse: presence + claims live directly on the engine. Reading either
 * does NOT open a new
 * connection — they ride the engine's existing socket. This pin
 * asserts that fact at the SDK level.
 *
 * A separate client for a bot still owns a separate socket because it is a
 * separate identity. That is not the duplication this pin tests for.
 */

import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { Ablo, type InternalAbloOptions } from '../../../src/Ablo';

// ── Counting WebSocket wrapper ──────────────────────────────────────

const wsConstructions: string[] = [];
const originalWebSocket = globalThis.WebSocket;

class CountingWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  url: string;
  readyState = CountingWS.OPEN;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(url: string | URL) {
    this.url = typeof url === 'string' ? url : url.toString();
    wsConstructions.push(this.url);
    queueMicrotask(() => {
      if (this.onopen) this.onopen(new Event('open'));
    });
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {}

  close(code = 1000, reason = ''): void {
    this.readyState = CountingWS.CLOSED;
    if (this.onclose) this.onclose(new CloseEvent('close', { code, reason }));
  }
}

const testSchema = defineSchema({
  presence: model(
    {
      title: z.string(),
    },
    { groups: { root: 'note' } }),
});

describe('Architectural pin — one WebSocket per engine', () => {
  beforeEach(() => {
    wsConstructions.length = 0;
    globalThis.WebSocket = CountingWS as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('opens exactly ONE WebSocket when entity sync, model presence, and claims are used together', async () => {
    const opts: InternalAbloOptions<typeof testSchema.models> = {
      baseURL: 'ws://localhost:8080',
      schema: testSchema,
      organizationId: 'org-1',
      branchId: 'br_test',
      branchRoot: false,
      kind: 'agent',
      agentId: 'worker-1',
      inMemory: true,
      capabilityToken: 'test-token',
      bootstrapMode: 'none',
    };
    const engine = Ablo(opts);
    void engine.ready().catch(() => {});

    // Reading model presence + claims from the engine. Pre-collapse this opened a
    // second presence client. These properties now ride the existing transport.
    const presence = engine.presence.forModel('notes');
    const claims = engine.claims;

    expect(presence).toEqual([]);
    claims.onChange(() => {});

    // Microtask drain so any deferred-attach `transport.subscribe`
    // calls land.
    await new Promise((r) => setTimeout(r, 50));

    // ── The pin ──────────────────────────────────────────────────────
    expect(wsConstructions.length).toBe(1);

    await engine.dispose().catch(() => {});
  });
});
