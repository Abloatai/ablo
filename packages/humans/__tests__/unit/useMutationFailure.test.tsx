/** @jest-environment jsdom */
import { StrictMode, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { Ablo } from '../../src/Ablo.js';
import { createAbloReact } from '../../src/react/createAbloReact.js';
import { defineSchema } from '@abloatai/transaction/schema/schema';
import { model } from '@abloatai/transaction/schema/model';
import { z } from 'zod';

const schema = defineSchema({ notes: model({ title: z.string() }) });
const binding = createAbloReact(schema);
const failure: Ablo.MutationFailure = {
  error: new Error('rejected'),
  transaction: {
    id: 'tx', type: 'update', modelName: 'Note', modelKey: 'notes', modelId: 'note',
    context: { userId: 'user', organizationId: 'org' }, status: 'failed',
    createdAt: 0, attempts: 1, priority: 'normal', priorityScore: 0,
  },
};

it('uses committed callbacks and moves one subscription on client rotation in StrictMode', async () => {
  function setup() {
    const client = Ablo({ schema, persistence: 'memory', baseURL: 'http://localhost' });
    jest.spyOn(client, 'ready').mockResolvedValue();
    const listeners = new Set<(event: Ablo.MutationFailure) => void>();
    const subscribe = jest.spyOn(client, 'onMutationFailure').mockImplementation(listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    });
    return { client, listeners, subscribe };
  }
  const first = setup();
  const second = setup();
  let active = first.client;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode><binding.AbloProvider client={active} fallback="passthrough">{children}</binding.AbloProvider></StrictMode>
  );
  const received: string[] = [];
  const { result, rerender, unmount } = renderHook(({ label }) => {
    binding.useMutationFailure(event => { received.push(`${label}:${event.error.message}`); });
    return binding.useAbloClient();
  }, { wrapper, initialProps: { label: 'first' } });
  expect(result.current).toBe(first.client);
  expect(first.listeners.size).toBe(1);
  const calls = first.subscribe.mock.calls.length;
  rerender({ label: 'latest' });
  expect(first.subscribe).toHaveBeenCalledTimes(calls);
  act(() => { for (const listener of first.listeners) listener(failure); });
  expect(received).toEqual(['latest:rejected']);
  active = second.client;
  rerender({ label: 'second' });
  expect(result.current).toBe(second.client);
  expect(first.listeners.size).toBe(0);
  expect(second.listeners.size).toBe(1);
  act(() => { for (const listener of second.listeners) listener(failure); });
  expect(received).toEqual(['latest:rejected', 'second:rejected']);
  unmount();
  expect(second.listeners.size).toBe(0);
  await Promise.all([first.client.dispose(), second.client.dispose()]);
});
