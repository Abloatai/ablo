import { Ablo } from '../../src/Ablo.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { z } from 'zod';

const schema = defineSchema({
  files: model({ name: z.string() }, { typename: 'File' }),
});

const delivered = {
  target: { model: 'File', id: 'file-1', syncGroup: 'file:file-1' },
  event: 'cursor',
  payload: { line: 12, column: 4 },
  sender: {
    presenceSessionId: 'b6741f5a-e982-4f9c-916b-2d247b8d4646',
    participant: { id: 'agent-coder', kind: 'agent' as const },
  },
  sentAt: '2026-09-05T10:00:00.000Z',
};

describe('model events', () => {
  it('derives the model record group and exposes authenticated delivery context', async () => {
    const client = Ablo({ schema, persistence: 'memory', baseURL: 'http://localhost:8080' });
    const send = jest.spyOn(client._ws, 'sendModelEvent').mockImplementation(() => undefined);
    const enterScope = jest.spyOn(client._store, 'enterScope').mockResolvedValue(undefined);
    const leaveScope = jest.spyOn(client._store, 'leaveScope').mockResolvedValue(undefined);
    const handler = jest.fn();

    const unsubscribe = client.files.events.subscribe('file-1', 'cursor', handler);
    await Promise.resolve();
    client._ws.emit('model_event', delivered);

    expect(enterScope).toHaveBeenCalledWith({ files: 'file-1' });
    expect(handler).toHaveBeenCalledWith(
      { line: 12, column: 4 },
      { sender: delivered.sender, sentAt: delivered.sentAt },
    );

    client.files.events.send('file-1', 'cursor', { line: 13, column: 1 });
    await Promise.resolve();
    expect(send).toHaveBeenCalledWith({
      target: { model: 'File', id: 'file-1', syncGroup: 'file:file-1' },
      event: 'cursor',
      payload: { line: 13, column: 1 },
    });

    unsubscribe();
    expect(leaveScope).toHaveBeenCalledWith({ files: 'file-1' });
    await client.dispose();
  });

  it('releases a scope when disposed before its join completes', async () => {
    const client = Ablo({ schema, persistence: 'memory', baseURL: 'http://localhost:8080' });
    let finishJoin: (() => void) | undefined;
    jest.spyOn(client._store, 'enterScope').mockImplementation(() =>
      new Promise<void>((resolve) => { finishJoin = resolve; }),
    );
    const leaveScope = jest.spyOn(client._store, 'leaveScope').mockResolvedValue(undefined);
    const handler = jest.fn();

    const unsubscribe = client.files.events.subscribe('file-1', 'cursor', handler);
    unsubscribe();
    finishJoin?.();
    await Promise.resolve();
    client._ws.emit('model_event', delivered);

    expect(leaveScope).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
    await client.dispose();
  });
});
