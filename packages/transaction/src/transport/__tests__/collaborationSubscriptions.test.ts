import { describe, expect, it, jest } from '@jest/globals';
import { WsTransport } from '../websocket/transport.js';
import type { CollaborationEventContext } from '../../collaboration/contract.js';

type Events = { cursor: [payload: { x: number }] };
interface Adapter {
  subscribe<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void;
}

describe('collaboration subscription boundary', () => {
  it('preserves generic adapter tuples while attributed subscriptions receive optional context', () => {
    const transport = new WsTransport<Events>({ baseUrl: 'http://localhost' });
    const adapter: Adapter = transport;
    const payloads: number[] = [];
    const removePlain = adapter.subscribe('cursor', payload => { payloads.push(payload.x); });
    const attributed = jest.fn<(...args: [Events['cursor'][0], CollaborationEventContext?]) => void>();
    const removeAttributed = transport.subscribeCollaboration('cursor', attributed);
    const context: CollaborationEventContext = {
      sender: { presenceSessionId: 'session-1', participant: { id: 'user-1', kind: 'user' } },
      sentAt: '2026-09-07T10:00:00.000Z',
    };
    transport.emit('cursor', { x: 1 }, context);
    transport.emit('cursor', { x: 2 });
    expect(payloads).toEqual([1, 2]);
    expect(attributed.mock.calls).toEqual([[{ x: 1 }, context], [{ x: 2 }]]);
    removePlain();
    removeAttributed();
    expect(transport.listenerCount('cursor')).toBe(0);
  });
});
