import { AbloStaleContextError } from '@abloatai/transaction/errors';
import { contextOnChange } from '../../../src/local/sync/contextOnChange';

describe('contextOnChange', () => {
  it('uses the existing delta subscription and stops after the first matching change', () => {
    const handlers = new Map<string, (value?: unknown) => void>();
    const transport = {
      subscribe(event: string, handler: (value?: unknown) => void) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
    };
    const changed: AbloStaleContextError[] = [];
    contextOnChange(
      transport,
      {
        peek: () => undefined,
        watermarks: { of: () => undefined },
      } as never,
      [{ model: 'record', id: 'record-1', readAt: 17 }],
      (error) => changed.push(error),
    );

    handlers.get('delta')?.({ id: 16, modelName: 'Record', modelId: 'record-1' });
    handlers.get('delta')?.({ id: 23, modelName: 'Record', modelId: 'other' });
    handlers.get('delta')?.({ id: 23, modelName: 'Record', modelId: 'record-1' });

    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      code: 'stale_context',
      conflicts: [{ model: 'record', id: 'record-1', observedSyncId: 23 }],
    });
    expect(handlers.size).toBe(0);
  });
});
