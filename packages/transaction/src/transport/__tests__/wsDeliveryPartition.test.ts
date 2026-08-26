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
});
