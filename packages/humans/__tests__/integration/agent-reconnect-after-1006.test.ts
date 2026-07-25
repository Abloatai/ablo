/**
 * Agent-host WS recovery — end-to-end 1006 → reconnect.
 *
 * This is the safety-net integration test for the agent-worker class
 * of bugs we hit in production (see `feedback_node_ws_reconnect_and_http_auth.md`):
 *
 *  - WS dies abnormally (code 1006).
 *  - ConnectionManager USED to transition `connected → offline` and call
 *    `syncWebSocket.disconnect()`, cancelling the scheduleReconnect that
 *    SyncWebSocket had just queued.
 *  - On agent hosts the FSM has no browser events to drive recovery, so
 *    it was parked in `offline` forever — jobs piled up at `pending`.
 *
 * The fix: `BaseSyncedStore.createConnectionManager` returns `null` for
 * `kind === 'agent'`, leaving SyncWebSocket's own exponential-backoff
 * `scheduleReconnect` as the sole recovery path.
 *
 * This test boots an agent-kind Ablo against a mock global WebSocket,
 * force-closes the connection with 1006, and asserts that a SECOND
 * WebSocket gets constructed (= reconnect fired) within the reconnect
 * window. If the FSM ever sneaks back in and starts killing reconnect,
 * this test fails immediately.
 */

import { z } from 'zod';
import { defineSchema } from '@abloatai/transaction/schema';
import { model } from '@abloatai/transaction/schema/model';
import { Ablo, type InternalAbloOptions } from '../../src/Ablo';

// `Ablo()`'s public overload (`AbloOptions`) hides internal-only knobs
// like `kind`, `agentId`, `bootstrapMode`, `capabilityToken`, `inMemory`
// — but the factory itself accepts `InternalAbloOptions`, which is what
// these tests need to drive the agent-host code path. Typing against it
// directly (rather than the public params) is what lets us pass those
// fields without an `as unknown` escape hatch.
type AbloTestOpts = InternalAbloOptions<(typeof testSchema)['models']>;

// ── Controllable mock WebSocket ─────────────────────────────────────
//
// Tracks every construction (so the test can prove a 2nd socket
// opened after a 1006 close) and exposes a `forceClose(code)` API on
// the most recent instance so the test can simulate the disconnect.

const wsConstructions: MockWS[] = [];
const originalWebSocket = globalThis.WebSocket;

class MockWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = MockWS.OPEN;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  sent: string[] = [];
  private wasManuallyClosed = false;

  constructor(url: string | URL) {
    this.url = typeof url === 'string' ? url : url.toString();
    wsConstructions.push(this);
    // Fire onopen on the next microtask so the consumer's `onopen`
    // handler has been attached.
    queueMicrotask(() => {
      if (this.onopen) this.onopen(new Event('open'));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string') this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.wasManuallyClosed = true;
    this.readyState = MockWS.CLOSED;
    if (this.onclose) this.onclose(new CloseEvent('close', { code, reason }));
  }

  /** Test-only: simulate an abnormal close (server vanished / network blip). */
  forceClose(code = 1006, reason = ''): void {
    if (this.wasManuallyClosed) return; // idempotent
    this.readyState = MockWS.CLOSED;
    if (this.onclose) this.onclose(new CloseEvent('close', { code, reason }));
  }
}

const testSchema = defineSchema({
  notes: model(
    {
      title: z.string(),
    },
    // Scope-root marker: the old flat `scope: 'note'` option became
    // `groups.root` (Axis 2 — sync-group routing) in the model-options
    // renaming; same semantics (`note:<id>` groups).
    { groups: { root: 'note' } }),
});

describe('Agent-host WS reconnect after 1006 close', () => {
  beforeEach(() => {
    wsConstructions.length = 0;
    globalThis.WebSocket = MockWS as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
  });

  it('reconnects automatically after a 1006 close (no ConnectionManager interference)', async () => {
    const engine = Ablo({
      baseURL: 'ws://localhost:8080',
      schema: testSchema,
      organizationId: 'org-1',
      kind: 'agent',
      agentId: 'worker-1',
      bootstrapMode: 'none',
      inMemory: true,
      apiKey: 'test-key',
      capabilityToken: 'test-token',
    } as AbloTestOpts);

    // Kick off ready() — fire-and-forget; we don't need it to fully
    // resolve for the WS lifecycle test.
    void engine.ready().catch(() => {});

    // Wait for the first socket to be constructed and `onopen` fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(wsConstructions.length).toBeGreaterThanOrEqual(1);

    const firstSocket = wsConstructions[0];
    expect(firstSocket).toBeDefined();
    if (!firstSocket) throw new Error('expected the first mock WebSocket to be constructed');

    // Simulate abnormal close — the production failure mode.
    firstSocket.forceClose(1006, '');

    // SyncWebSocket schedules reconnect with `reconnectDelay: 1000ms`
    // for the first attempt (see SyncWebSocket.ts:414). Wait long
    // enough for one cycle.
    await new Promise((r) => setTimeout(r, 1500));

    // ── The pin ──────────────────────────────────────────────────────
    // A SECOND socket must have been constructed. Before the fix, the
    // ConnectionManager FSM would have cancelled the reconnect by
    // calling syncWebSocket.disconnect() on entering `offline`, and
    // wsConstructions.length would stay at 1 forever.
    expect(wsConstructions.length).toBeGreaterThanOrEqual(2);

    await engine.dispose().catch(() => {});
  }, 10_000);

  it('does not construct ConnectionManager for kind: agent', async () => {
    // Indirect proof: if the FSM existed, it would log
    // `[ConnectionManager] Started` and respond to WS_DISCONNECTED by
    // calling disconnect() — which sets isManualClose=true and would
    // prevent the reconnect we just verified above. The previous test
    // is the strong assertion; this one documents the mechanism.
    const engine = Ablo({
      baseURL: 'ws://localhost:8080',
      schema: testSchema,
      organizationId: 'org-1',
      kind: 'agent',
      agentId: 'worker-2',
      bootstrapMode: 'none',
      inMemory: true,
      apiKey: 'test-key',
      capabilityToken: 'test-token',
    } as AbloTestOpts);

    void engine.ready().catch(() => {});
    await new Promise((r) => setTimeout(r, 50));

    // Reach into the internal store to verify the manager is null.
    // The `_store` accessor is documented as "internal but stable" on
    // the engine return shape (Ablo.ts).
    const internalStore = (engine as unknown as { _store: { connectionManager: unknown } })._store;
    expect(internalStore.connectionManager).toBeNull();

    await engine.dispose().catch(() => {});
  });
});
