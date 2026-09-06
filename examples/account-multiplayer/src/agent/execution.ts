import Ablo from '@abloatai/ablo';
import Sessions from '@abloatai/ablo/sessions';
import { setTimeout } from 'node:timers/promises';
import { schema } from '../schema.js';
import { grantAgent } from '../accounts/index.js';
import { startOwnedRun } from './lifetime.js';

export function startAgent(issuer: ReturnType<typeof Sessions<typeof schema.models>>, account: string, id: string, agentId: string) {
  const client = Ablo({
    schema,
    baseURL: process.env.ABLO_BASE_URL,
    session: () => issuer.create(grantAgent(account, agentId)),
    transport: 'http',
  });
  return startOwnedRun({
    acquire: (onLost) => client.conversations.claim(id, {
      fields: fields => [fields.executionOwner, fields.executionState],
      contention: { mode: 'skip' },
      ttl: '30s',
      heartbeat: { every: '10s', onLost },
    }),
    async execute(claim, signal) {
      signal.throwIfAborted();
      const initial = await client.conversations.read({ id });
      if (!initial) throw new Error('Conversation disappeared before execution');
      signal.throwIfAborted();
      await client.conversations.update({ id, claim, reads: [initial], data: {
        executionOwner: agentId, executionState: 'generating',
      } });
      // Stand-in for application-owned execution, with cooperative cancellation.
      await setTimeout(3000, undefined, { signal });
      signal.throwIfAborted();
      // Each mutation names fresh read evidence while retaining the lease/fence.
      const current = await client.conversations.read({ id });
      if (!current) throw new Error('Conversation disappeared during execution');
      signal.throwIfAborted();
      await client.conversations.update({ id, claim, reads: [current], data: { executionState: 'idle' } });
      // Ownership can remain while execution is idle. The UI displays both.
      await setTimeout(3000, undefined, { signal });
    },
    dispose: () => client.dispose(),
  });
}
