/**
 * Canonical cheap turn: explicitly attach the exact rows used to decide the
 * write. Ablo keeps their watermarks opaque and checks them at commit time.
 *
 * Run: ABLO_API_KEY=sk_... RECORD_ID=record_... npx tsx examples/agent-turn.ts
 */
import { Ablo } from '@abloatai/ablo';
import { defineSchema, model, z } from '@abloatai/ablo/schema';

const schema = defineSchema({
  records: model({
    title: z.string(),
    status: z.enum(['pending', 'done']),
    result: z.string().optional(),
  }),
});

const recordId = process.env.RECORD_ID;
if (!recordId) throw new Error('RECORD_ID is required');

const ablo = Ablo({ schema, apiKey: process.env.ABLO_API_KEY });
try {
  await ablo.ready();
  const record = await ablo.records.read({ id: recordId });
  if (!record) throw new Error(`Record ${recordId} was not found`);
  const commitId = `record:${recordId}:cheap`;
  await ablo.records.update({
    id: record.id,
    data: { status: 'done', result: `Completed: ${record.title}` },
    reads: [record],
    idempotencyKey: commitId,
  });
  const commit = await ablo.commits.get({ id: commitId });
  console.log({ identity: ablo.identity, commit });
} finally {
  await ablo.dispose();
}
