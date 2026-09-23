import { WsTransport } from '../websocket/transport.js';

describe('WsTransport delivery routing', () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  });

  it('echoes the late-bound server route on the held first upgrade', () => {
    let openedUrl = '';

    class CapturingWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly readyState = CapturingWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;

      constructor(url: string | URL) {
        openedUrl = String(url);
      }

      close(): void {}
      send(): void {}
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: CapturingWebSocket,
    });

    const transport = new WsTransport({
      baseUrl: 'https://sync.example.test',
      deferConnect: true,
    });
    transport.setDeliveryPartition({ index: 3, count: 8 });
    transport.allowConnect();
    transport.connect();

    expect(new URL(openedUrl).searchParams.get('deliveryPartition')).toBe('3-8');
    transport.disconnect();
  });

  it('confirms large subscriptions after upgrade and before reporting connected', async () => {
    class CapturingWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static instance: CapturingWebSocket;

      readyState = CapturingWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      sent: unknown[] = [];

      constructor(readonly url: string) { CapturingWebSocket.instance = this; }
      send(value: string): void { this.sent.push(JSON.parse(value)); }
      close(): void { this.readyState = CapturingWebSocket.CLOSED; }
      receive(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: CapturingWebSocket,
    });

    const groups = Array.from({ length: 60 }, (_, i) => `repository:org:${i.toString().padStart(40, '0')}`);
    const transport = new WsTransport({ baseUrl: 'https://sync.example.test', syncGroups: groups });
    let connected = false;
    transport.subscribe('connected', () => { connected = true; });
    transport.connect();
    const socket = CapturingWebSocket.instance;
    expect(socket.url.length).toBeLessThanOrEqual(2_000);
    expect(new URL(socket.url).searchParams.getAll('syncGroups')).toEqual([]);

    socket.readyState = CapturingWebSocket.OPEN;
    socket.onopen?.();
    socket.receive({ type: 'presence_session', payload: { presenceSessionId: 'b6741f5a-e982-4f9c-916b-2d247b8d4646', resumed: false } });
    expect(socket.sent).toContainEqual({ type: 'update_subscription', payload: { syncGroups: groups } });
    expect(connected).toBe(false);
    socket.receive({ type: 'subscription_ack', payload: { success: true, syncGroups: groups } });
    await Promise.resolve();
    expect(connected).toBe(true);
    transport.disconnect();
  });

  it('closes with a browser-valid code when the initial subscription fails', async () => {
    class RejectingWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      static instance: RejectingWebSocket;
      readyState = RejectingWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      closeCode: number | null = null;

      constructor() { RejectingWebSocket.instance = this; }
      send(): void {}
      close(code: number): void {
        if (code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException('Invalid close code', 'InvalidAccessError');
        this.closeCode = code;
        this.onclose?.({ code, reason: 'initial_subscription_failed' } as CloseEvent);
      }
      receive(frame: unknown): void {
        this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
      }
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: RejectingWebSocket,
    });

    const groups = Array.from({ length: 60 }, (_, i) => `repository:org:${i.toString().padStart(40, '0')}`);
    const transport = new WsTransport({ baseUrl: 'https://sync.example.test', syncGroups: groups });
    const errors: Error[] = [];
    transport.subscribe('error', error => { errors.push(error); });
    transport.connect();
    const socket = RejectingWebSocket.instance;
    socket.onopen?.();
    socket.receive({ type: 'presence_session', payload: { presenceSessionId: 'b6741f5a-e982-4f9c-916b-2d247b8d4646', resumed: false } });
    socket.receive({ type: 'subscription_ack', payload: { success: false, syncGroups: [], error: { code: 'malformed_subscription', message: 'Rejected scope' } } });
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.closeCode).toBe(4000);
    expect(errors[0]?.message).toContain('Rejected scope');
    transport.disconnect();
  });

  it('suppresses a synchronous socket error caused by manual disconnect', () => {
    class ErrorOnCloseWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly readyState = ErrorOnCloseWebSocket.OPEN;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: (() => void) | null = null;

      close(): void { this.onerror?.(); }
      send(): void {}
    }

    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      writable: true,
      value: ErrorOnCloseWebSocket,
    });

    const transport = new WsTransport({ baseUrl: 'https://sync.example.test' });
    transport.connect();
    expect(() => transport.disconnect()).not.toThrow();
  });
});
