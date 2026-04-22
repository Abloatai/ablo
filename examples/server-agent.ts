/**
 * Shape 1 — Server agent.
 *
 * Long-lived backend process that joins the mesh with the server-side
 * API key, does work on a matter, broadcasts what it's doing so peers
 * can observe, writes through the customer's own DB, and exits.
 *
 * The canonical shape for: due-diligence bots, nightly report
 * generators, SQS/Lambda workers, scheduled jobs.
 *
 * Run:
 *
 *   ABLO_API_KEY=sk_test_... npx tsx server-agent.ts <matterId>
 */

import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

async function main() {
  const matterId = process.argv[2];
  if (!matterId) {
    throw new Error('Usage: tsx server-agent.ts <matterId>');
  }

  // Reads ABLO_API_KEY from env; org is derived server-side from the key.
  const ablo = new Ablo({ schema });

  // Model-scoped join — auto-connects, reserves a 1-hour capability.
  const participant = await ablo.matters.join(matterId, {
    label: 'Due Diligence Bot',
    ttlSeconds: '1h',
  });
  participant.autoRefresh();

  try {
    // Broadcast what the bot is doing. Peers on the same matter see this
    // in their own `participant.presence.others` stream.
    participant.presence.viewing(['Matter', matterId]);

    // Claim write intent on a specific clause. `await using` auto-revokes
    // when the enclosing block exits (or throws) — no try/finally.
    const clauseId = 'clause-3-2';
    await using _work = participant.intents.writing(['Clause', clauseId], {
      ttl: '3m',
    });

    // Snapshot the clause so we can write honestly against it — the
    // stamp will be rejected server-side if the clause moves during
    // our reasoning. The signal aborts the LLM call if anything
    // captured changes during generation.
    const snap = await participant.snapshot({ clauses: [clauseId] });

    // Run the LLM. Replace with your provider.
    //   const response = await yourLLM.draft(snap.clauses[clauseId], { signal: snap.signal });
    const draftText = `[stub LLM output for clause ${clauseId}]`;

    // Writes go through the customer's own API. `readAt: snap.stamp`
    // is passed so the customer's write-path can refuse stale writes.
    //   await yourAPI.patchClause(clauseId, { draftText }, { readAt: snap.stamp });
    console.log('Would write:', { clauseId, draftText, readAt: snap.stamp });
  } finally {
    await participant.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
