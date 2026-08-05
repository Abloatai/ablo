/**
 * Canonical expensive turn: live claim, heartbeat,
 * post-grant model input, ordinary guarded update, durable commit retrieval,
 * automatic release, and an explicit lost-claim fencing proof.
 *
 * Run: ABLO_API_KEY=sk_... JOB_ID=job_... npx tsx examples/expensive-agent-turn.ts
 */
import { Ablo, AbloClaimedError } from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  researchJobs: model({
    prompt: z.string(),
    status: z.enum(['pending', 'complete']),
    answer: z.string().optional(),
  }),
});

async function callExpensiveModel(prompt: string): Promise<string> {
  // Replace this deterministic stand-in with the model provider used by the app.
  await new Promise((resolve) => setTimeout(resolve, 25));
  return `Model answer for: ${prompt}`;
}

const jobId = process.env.JOB_ID;
if (!jobId) throw new Error('JOB_ID is required');

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });

try {
  await ablo.ready();
  const commitId = `research:${jobId}:expensive`;
  await using claim = await ablo.researchJobs.claim({
    id: jobId,
    description: 'expensive model turn',
    ttl: '30s',
    heartbeat: { every: '10s' },
  });
  const answer = await callExpensiveModel(claim.data.prompt);
  await claim.heartbeat({ details: { phase: 'writing' } });
  await ablo.researchJobs.update({
    id: claim.data.id,
    data: { status: 'complete', answer },
    claim,
    idempotencyKey: commitId,
  });

  const durable = await ablo.commits.get({ id: commitId });
  if (!durable) throw new Error(`Commit ${commitId} was not retained`);
  console.log({
    identity: ablo.identity,
    readSet: durable.readSet,
    attempts: durable.attempts,
    claims: durable.claims,
    authority: durable.authority,
    status: durable.status,
    confirmationMs: Date.parse(durable.statusAt) - Date.parse(durable.createdAt),
  });

  const lost = await ablo.researchJobs.claim({ id: jobId, ttl: '30s' });
  await lost.release();
  try {
    await ablo.researchJobs.update({
      id: lost.data.id,
      data: { status: 'complete', answer: 'must not land' },
      claim: lost,
      idempotencyKey: `research:${jobId}:lost-claim-proof`,
    });
    throw new Error('A released claim was not fenced');
  } catch (error) {
    if (!(error instanceof AbloClaimedError) || error.code !== 'claim_lost') throw error;
    console.log('lost claim fenced', error.code);
  }
} finally {
  await ablo.dispose();
}
