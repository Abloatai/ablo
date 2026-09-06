import { randomUUID } from 'node:crypto';
import type Sessions from '@abloatai/ablo/sessions';
import type { schema } from '../schema.js';
import { startAgent } from './execution.js';

/** Account-scoped run receipts outlive the HTTP request that starts execution. */
export function createAgentRunner(issuer: ReturnType<typeof Sessions<typeof schema.models>>) {
  const runs = new Map<string, {
    account: string;
    run: ReturnType<typeof startAgent>;
    expires?: ReturnType<typeof setTimeout>;
  }>();
  let stopping = false;
  return {
    start(account: string, conversationId: string) {
      if (stopping) throw new Error('Agent runner is stopping');
      const runId = randomUUID();
      const run = startAgent(issuer, account, conversationId, runId);
      const entry: { account: string; run: typeof run; expires?: ReturnType<typeof setTimeout> } = { account, run };
      runs.set(runId, entry);
      void run.done.catch(console.error).finally(() => {
        if (!stopping) {
          // Keep completed receipts briefly for callers to observe the outcome.
          entry.expires = setTimeout(() => runs.delete(runId), 60_000);
          entry.expires.unref();
        }
      });
      return { runId };
    },
    getStatus(account: string, runId: string) {
      const entry = runs.get(runId);
      if (!entry || entry.account !== account) return null;
      return { runId, status: entry.run.status, executions: entry.run.executions };
    },
    async stop() {
      stopping = true;
      await Promise.allSettled([...runs.values()].map(({ run, expires }) => {
        clearTimeout(expires);
        return run.stop();
      }));
      runs.clear();
    },
  };
}
