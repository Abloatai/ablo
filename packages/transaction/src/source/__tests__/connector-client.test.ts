import { describe, expect, it, jest } from '@jest/globals';

import {
  SOURCE_CONNECTOR_PROTOCOL_VERSION,
  SOURCE_CONNECTOR_SUPERSEDED_CLOSE_CODE,
  createSourceConnector,
  encodeFrame,
  type ConnectorWebSocket,
} from '../connector/index.js';

type Listener = (event: never) => void;

class FakeWebSocket implements ConnectorWebSocket {
  readonly listeners = new Map<string, Listener[]>();
  readonly sent: string[] = [];
  readyState = 1;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.emit('close', { code, reason });
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: unknown = undefined): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as never);
    }
  }
}

describe('source connector ownership fencing', () => {
  it('stops reconnecting when a newer connector supersedes it', async () => {
    const sockets: FakeWebSocket[] = [];
    const onError = jest.fn();
    const connector = createSourceConnector({
      apiKey: 'sk_test_connector',
      handler: async () => new Response('{}'),
      reconnectSchedule: [0],
      jitter: 0,
      webSocket: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      onError,
    });

    const run = connector.run(new AbortController().signal);
    expect(sockets).toHaveLength(1);
    sockets[0]!.emit('open');
    sockets[0]!.emit('message', {
      data: encodeFrame({
        type: 'ready',
        protocolVersion: SOURCE_CONNECTOR_PROTOCOL_VERSION,
      }),
    });
    sockets[0]!.emit('close', {
      code: SOURCE_CONNECTOR_SUPERSEDED_CLOSE_CODE,
      reason: 'source_connector_superseded',
    });

    await expect(run).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'source_connector_superseded' }),
    );
  });
});
