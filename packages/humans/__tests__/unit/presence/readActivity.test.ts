import type { PresenceCommand } from '@abloatai/transaction/presence';
import {
  startReadActivity,
  type ReadActivityTransport,
} from '../../../src/presence/readActivity.js';
import { LEASE_TTL_MS } from '@abloatai/transaction/wire';

class TestTransport implements ReadActivityTransport {
  connected = true;
  readonly commands: PresenceCommand[] = [];
  private readonly connectedListeners = new Set<() => void>();

  isConnected(): boolean {
    return this.connected;
  }

  sendPresenceCommand(command: PresenceCommand): void {
    this.commands.push(command);
  }

  subscribe(_event: 'connected', listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => { this.connectedListeners.delete(listener); };
  }

  reconnect(): void {
    this.connected = true;
    for (const listener of [...this.connectedListeners]) listener();
  }
}

describe('read presence activity lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('upserts, refreshes, re-announces after reconnect, and removes on stop', () => {
    const transport = new TestTransport();
    const lifetime = startReadActivity(transport, { model: 'Chat', id: 'chat-1' });

    const first = transport.commands[0];
    expect(first).toMatchObject({
      type: 'read.upsert',
      target: { model: 'Chat', id: 'chat-1' },
      ttlMs: LEASE_TTL_MS,
    });

    jest.advanceTimersByTime(LEASE_TTL_MS / 3);
    expect(transport.commands.at(-1)).toEqual({
      type: 'read.refresh',
      activityId: first?.activityId,
      ttlMs: LEASE_TTL_MS,
    });

    transport.connected = false;
    transport.reconnect();
    expect(transport.commands.at(-1)).toEqual(first);

    lifetime.stop();
    expect(transport.commands.at(-1)).toEqual({
      type: 'read.remove',
      activityId: first?.activityId,
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('removes on a later reconnect when the component leaves offline', () => {
    const transport = new TestTransport();
    transport.connected = false;
    const finished = jest.fn();
    const lifetime = startReadActivity(
      transport,
      { model: 'Chat', id: 'chat-1' },
      finished,
    );

    expect(transport.commands).toEqual([]);
    transport.reconnect();
    const activityId = transport.commands[0]?.activityId;
    transport.connected = false;
    lifetime.stop();
    expect(finished).not.toHaveBeenCalled();

    transport.reconnect();
    expect(transport.commands.at(-1)).toEqual({ type: 'read.remove', activityId });
    expect(finished).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears every local timer and listener when its owner is disposed', () => {
    const transport = new TestTransport();
    const finished = jest.fn();
    const lifetime = startReadActivity(
      transport,
      { model: 'Chat', id: 'chat-1' },
      finished,
    );

    lifetime.dispose();
    transport.reconnect();

    expect(transport.commands).toHaveLength(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
