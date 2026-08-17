/**
 * A lease outlives the process that took it.
 *
 * Run in two terminals against your own project. The `holder` takes a claim
 * and is killed without releasing it, exactly as a sandbox that is torn down
 * mid-turn would be. The `successor`, already queued, is granted the claim when
 * the lease lapses and reads the row as it stands then.
 *
 * Terminal 1: ABLO_API_KEY=sk_... JOB_ID=job_... npx tsx examples/lease-outlives-the-machine.ts holder
 * Terminal 2: ABLO_API_KEY=sk_... JOB_ID=job_... npx tsx examples/lease-outlives-the-machine.ts successor
 *
 * Start the successor first, then the holder, so the queue is populated before
 * the lease lapses.
 */
import { Ablo } from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  jobs: model({
    prompt: z.string(),
    status: z.enum(['pending', 'complete']),
    answer: z.string().optional(),
  }),
});

const role = process.argv[2];
if (role !== 'holder' && role !== 'successor') {
  throw new Error('Pass "holder" or "successor" as the first argument');
}

const jobId = process.env.JOB_ID;
if (!jobId) throw new Error('JOB_ID is required');

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
await ablo.ready();

if (role === 'holder') {
  // A short TTL and no heartbeat: this process takes the lease and then stops
  // proving it is alive, which is what a machine that disappears looks like
  // from the server's side.
  const claim = await ablo.jobs.claim({
    id: jobId,
    description: 'drafting the summary',
    ttl: '10s',
  });
  console.log('holder: lease taken, status is', claim.data.status);
  console.log('holder: exiting without releasing it');
  // Deliberately skip release and skip dispose. `process.exit` runs no
  // cleanup, so the server never hears from this participant again.
  process.exit(0);
}

console.log('successor: queueing behind whoever holds the lease');
const started = Date.now();
await using claim = await ablo.jobs.claim({
  id: jobId,
  description: 'taking over the draft',
  ttl: '30s',
  heartbeat: { every: '10s' },
});
console.log(`successor: granted after ${Math.round((Date.now() - started) / 1000)}s`);
console.log('successor: read the row as it stands now —', {
  status: claim.data.status,
  answer: claim.data.answer,
});
await ablo.dispose();
