/**
 * Shape 3 — Sub-agent spawn (attenuation chain).
 *
 * A parent agent holds a capability that covers a whole matter. It
 * spawns a specialist child agent (e.g. a risk analyzer, a summarizer)
 * whose capability is strictly narrower — same matter, but with
 * explicitly reduced scope. The child's Biscuit is cryptographically
 * attenuated from the parent's; revoking the parent cascades to every
 * descendant at next verify.
 *
 * Use this when:
 *   - One orchestrator agent dispatches work to purpose-built helpers.
 *   - You want per-helper audit trails and revocation granularity.
 *   - Helpers should never see more than the specific entities the
 *     orchestrator hands them.
 *
 * Run:
 *
 *   ABLO_API_KEY=sk_test_... npx tsx sub-agent.ts <matterId>
 */

import Ablo from '@ablo/sync-engine';
import { schema } from './schema';

async function main() {
  const matterId = process.argv[2];
  if (!matterId) {
    throw new Error('Usage: tsx sub-agent.ts <matterId>');
  }

  const ablo = new Ablo({ schema });

  // The parent joins the whole matter — full read/write across clauses.
  const parent = await ablo.matters.join(matterId, {
    label: 'Orchestrator',
    ttlSeconds: '2h',
  });

  try {
    // The parent dispatches a child to analyze one specific clause.
    // The child's capability is attenuated from the parent's — it
    // inherits the server-side mint, but the scope narrows.
    //
    // The `as` / `onBehalfOf` fields are NOT passed; the parent's
    // token is automatically the child's authority ceiling.
    const child = await parent.join(
      { label: 'Risk Analyzer' },
      {
        scope: { matters: matterId }, // must be ⊆ parent's scope
        ttlSeconds: '10m',
      },
    );

    try {
      // The child does its work. It can see presence / intents from
      // peers on the same matter (including the parent) — both appear
      // in `child.presence.others`. `update(...)` accepts arbitrary
      // action strings for app-specific verbs like "analyzing".
      child.presence.update({
        entityType: 'Clause',
        entityId: 'clause-3-2',
        action: 'analyzing',
      });

      // ... do the narrowly-scoped work ...
      console.log(`child ${child.id} is on matter ${matterId}`);
    } finally {
      await child.disconnect();
    }
  } finally {
    await parent.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
